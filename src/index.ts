const wget = require('wget-improved');
const pMap = require('p-map');
const PProgress = require('p-progress');
const axios = require('axios');
import path = require('path');
import fs = require('fs-extra');
import ffmpeg = require('fluent-ffmpeg');
import events = require('events');

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

    events: events.EventEmitter = new (events.EventEmitter)();
    private _eventCache: any;

    private _emit(channel: string, obj: any) {
        if (this._eventCache && (this._eventCache.channel === channel && JSON.stringify(this._eventCache.obj) === JSON.stringify(obj))) {
            return;
        } else {
            this._eventCache = {
                channel: channel,
                obj: obj
            };
        }

        this.events.emit(channel, obj);
    }

    private _processChunk(url: string, dest: string) {
        return new PProgress((resolve, reject, progress) => {
            fs.ensureDirSync(path.dirname(dest));

            let download = wget.download(url, dest);

            download.on('error', (err) => {
                return resolve({ success: false, error: err, local: dest });
            });

            download.on('start', (filesize) => {
                //console.log(`Downloading ${url}, filesize: ${filesize}`);
            });

            download.on('end', (output) => {
                //console.log(`Ended, ${output}`);
                return resolve({ success: true, local: dest });
            });

            download.on('progress', (p) => {
                progress({ chunk: path.basename(url, '.ts'), progress: p });
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
            this._emit('download-started', { uuid: uuid });

            let chunkProgress: Map<string, number> = new Map<string, number>();

            this._emit('download-status', { uuid: uuid, status: 'Getting chunks to download...' });

            let urls = await this._getUrlsFromPlaylist(playlist.video.url).catch(err => {
                return reject(`Couldn't get chunks to download: ${err}`);
            });

            let mapper = el => this._processChunk(el, this._getTempFilename(el, uuid)).onProgress(p => {
                chunkProgress.set(p.chunk, p.progress);
                let total = 0;

                for (let val of chunkProgress.values()) {
                    if (val) total += val;
                }

                total = Math.floor((total / (<string[]>urls).length) * 100);
                this._emit('download-progress', { uuid: uuid, percent: total });
            });

            this._emit('download-status', { uuid: uuid, status: 'Downloading chunks' });

            pMap(urls, mapper, { concurrency: 4 }).then(result => {
                this._emit('download-status', { uuid: uuid, status: 'Merging chunks' });

                let concatStr = '';

                for (let res of result) {
                    if (res.success) {
                        concatStr += `|${res.local}`;
                    } else {
                        return reject(`Failed to download at least one file`);
                    }
                }

                ffmpeg()
                    .outputOptions([
                        `-i concat:${concatStr.substr(1)}`,
                        '-c copy',
                        '-bsf:a aac_adtstoasc',
                        '-vsync 2',
                        '-movflags +faststart'
                    ])
                    .on('end', () => {
                        this._cleanupTempFiles(uuid);
                        return resolve();
                    })
                    .on('error', (err) => {
                        this._cleanupTempFiles(uuid);
                        return reject(err);
                    })
                    .output(this._getLocalFilename(playlist))
                    .run();
            });
        });
    }

    private _cleanupTempFiles(uuid: string) {
        this._emit('download-status', { uuid: uuid, status: 'Cleaning temporary files' });
        fs.removeSync(path.join(this._downloadDirectoryTemp, uuid));
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
        this._emit('download-queued', { uuid: uuid, display: `${playlist.user.name}: ${playlist.video.id}` });
        return uuid;
    }

    delete(uuid: string) {
        this._queue.delete(uuid);
        this._emit('download-deleted', { uuid: uuid });
    }

    start(uuid: string) {
        let item = this._queue.get(uuid);
        this._queue.delete(uuid);

        this._processItem(uuid, item)
            .then(result => {
                this._emit('download-completed', { uuid: uuid });
            })
            .catch(err => {
                this._emit('download-errored', { uuid: uuid, error: err });
            });
    }
}