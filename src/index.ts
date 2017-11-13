const wget = require('wget-improved');
const pMap = require('p-map');
const PProgress = require('p-progress');
const axios = require('axios');
import path = require('path');
import fs = require('fs-extra');
import ffmpeg = require('fluent-ffmpeg');

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export interface Playlist {
    user: {
        id: string,
        name: string
    };

    video: {
        id: string,
        title: string,
        time: number,
        url: string
    };
}

export class DownloadManager {
    private _queue: Map<string, Playlist> = new Map<string, Playlist>();
    private _downloadDirectory: string;
    private _downloadDirectoryTemp: string;
    private _downloadMask: string;

    private _processChunk(url: string, dest: string) {
        return new PProgress((resolve, reject, progress) => {
            fs.ensureDirSync(path.dirname(dest));

            let download = wget.download(url, dest);

            download.on('error', (err) => {
                return resolve({ success: false, error: err, local: dest });
            });

            download.on('start', (filesize) => {
                console.log(`Downloading ${url}, filesize: ${filesize}`);
            });

            download.on('end', (output) => {
                console.log(`Ended, ${output}`);
                return resolve({ success: true, local: dest });
            });

            download.on('progress', (p) => {
                console.log(`Progress ${p}`);
                progress(p);
            });
        });
    }

    private _getTempFilename(url: string, uuid: string): string {
        return path.join(this._downloadDirectoryTemp, uuid, path.basename(url));
    }

    private _getLocalFilename(playlist: Playlist): string {
        let defaultPath = path.join(this._downloadDirectory, path.basename(playlist.video.url).replace("m3u8", "mp4"));

        return defaultPath;
    }

    private _getUrlsFromPlaylist(m3u8: string): Promise<string[]> {
        return new Promise((resolve, reject) => {
            return axios
                .get(m3u8)
                .then(response => {
                    let playlist = [], baseURL = path.dirname(m3u8);

                    for (let line of <string[]>(response.data.split('\n'))) { // Go through the m3u8 line by line
                        line = line.trim();

                        if (line.length == 0 || line[0] == '#') { // If it's empty or starts with #, ignore it
                            continue;
                        }

                        line = line.split('?').shift();
                        line = `${baseURL}/${line}`;

                        if (playlist.indexOf(line) != -1) {
                            continue;
                        }

                        playlist.push(line);
                    }

                    return resolve(playlist);
                })
                .catch(err => {
                    return reject(err);
                });
        });
    }

    private _processItem(uuid: string, playlist: Playlist): Promise<void> {
        return new Promise(async (resolve, reject) => {
            let urls = await this._getUrlsFromPlaylist(playlist.video.url).catch(err => {
                return reject(`Couldn't get URLs to download: ${err}`);
            });

            let mapper = el => this._processChunk(el, this._getTempFilename(el, uuid)).onProgress(p => { console.log(`onProgress: ${p}`); });

            pMap(urls, mapper, { concurrency: 4 }).then(result => {
                console.log('DONE', result);

                let ff = ffmpeg();

                for (let res of result) {
                    if (res.success) {
                        ff.input(res.local);
                    } else {
                        return reject(`Failed to download at least one file`);
                    }
                }

                ff.on('end', () => {
                    return resolve();
                })
                .on('error', (err) => {
                    console.error(err);
                    return reject(err);
                })
                .mergeToFile(this._getLocalFilename(playlist));
            });
        });
    }

    init(download: string, temp: string, ffm: string, ffp: string) {
        this._downloadDirectory = download;
        this._downloadDirectoryTemp = temp;

        ffmpeg().setFfmpegPath(ffm);
        ffmpeg().setFfprobePath(ffp);
    }

    add(playlist: Playlist): string {
        let uuid = uuidv4();
        this._queue.set(uuid, playlist);
        return uuid;
    }

    delete(uuid: string) {
        this._queue.delete(uuid);
    }

    start(uuid: string) {
        this._processItem(uuid, this._queue.get(uuid));
    }
}