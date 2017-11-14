const wget = require('wget-improved');
const pMap = require('p-map');
const PProgress = require('p-progress');
const axios = require('axios');
import path = require('path');
import fs = require('fs-extra');
import ffmpeg = require('fluent-ffmpeg');
import events = require('events');
import app = require('./app');

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
    private _history: string[] = [];
    private _eventCache: any;
    private _paused: boolean = false;
    private _running: boolean = false;
    private _appSettings: any;

    events: events.EventEmitter = new (events.EventEmitter)();

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
        return path.join(this._appSettings.get('downloads.directory'), 'temp', uuid, path.basename(url));
    }

    private _getLocalFilename(playlist: Playlist): string {
        let defaultPath = path.join(this._appSettings.get('downloads.directory'), path.basename(playlist.video.url).replace("m3u8", "mp4"));
        let finalPath;

        if (this._appSettings.get('downloads.filemode') == 0) {
            finalPath = defaultPath;
        } else {
            let finalName = this._appSettings.get('downloads.filetemplate')
                .replace(/%%username%%/g, playlist.user.name)
                .replace(/%%userid%%/g, playlist.user.id)
                .replace(/%%videoid%%/g, playlist.video.id)
                .replace(/%%videotitle%%/g, playlist.video.title)
                .replace(/%%videotime%%/g, '' + playlist.video.time);

            if (!finalName || finalName == '') {
                finalPath = defaultPath;
            } else {
                finalPath = path.join(this._appSettings.get('downloads.directory'), finalName.replace(/[:*?""<>|]/g, '_') + ".mp4");
            }
        }

        let basename = path.basename(finalPath);

        if (basename == 'playlist.ts' || basename == 'playlist_eof.ts') {
            let parentName = path.basename(path.dirname(playlist.video.url));
            finalPath = finalPath.replace(basename, parentName + '.mp4');
        }

        fs.ensureDirSync(path.dirname(finalPath));
        return finalPath;
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
        fs.removeSync(path.join(this._appSettings.get('downloads.directory'), 'temp', uuid));
    }

    init(appSettings: any) {
        this._appSettings = appSettings;

        let mpeg = appSettings.get('downloads.ffmpeg'), probe = appSettings.get('downloads.ffprobe');

        if (mpeg && mpeg != 'ffmpeg') {
            ffmpeg().setFfmpegPath(mpeg);
        }

        if (probe && probe != 'ffprobe') {
            ffmpeg().setFfprobePath(probe);
        }
    }

    add(playlist: Playlist): string {
        let uuid = uuidv4();
        this._queue.set(uuid, playlist);
        this._emit('download-queued', { uuid: uuid, display: `${playlist.user.name}: ${playlist.video.id}` });
        this.loop();
        return uuid;
    }

    delete(uuid: string) {
        this._queue.delete(uuid);
        this._emit('download-deleted', { uuid: uuid });
    }

    start(uuid: string): Promise<void> {
        let item = this._queue.get(uuid);
        this._queue.delete(uuid);

        return this._processItem(uuid, item)
            .then(result => {
                this._emit('download-completed', { uuid: uuid });

                if (this._appSettings.get('downloads.history')) {
                    this._history.push(item.video.id);
                }
            })
            .catch(err => {
                this._emit('download-errored', { uuid: uuid, error: err });
            });
    }

    async loop() {
        if (this._running || this._paused) {
            return;
        }

        this._running = true;

        while (this._queue.size > 0 && !this._paused) {
            await this.start(this._queue.keys().next().value); // Grab the next one in the list and start it
            this.saveQueue();
        }

        this._running = false;
    }

    isPaused() {
        return this._paused;
    }

    isRunning() {
        return this._running;
    }

    pause() {
        this._paused = true;
    }

    resume() {
        this._paused = false;
        this.loop();
    }

    load() {
        this.loadQueue();
        this.loadHistory();
    }

    hasBeenDownloaded(videoid: string) {
        return this._history.indexOf(videoid) != -1;
    }

    purgeHistory() {
        fs.removeSync(path.join(app.getPath('appData'), app.getName(), 'downloadHistory.json'));
        this._history = [];
    }

    purgeQueue() {
        this._queue = new Map<string, Playlist>();
        this.saveQueue();
        this._emit('download-queue-clear', null);
    }

    setFfmpegPath(path: string) {
        ffmpeg().setFfmpegPath(path);
    }

    setFfprobePath(path: string) {
        ffmpeg().setFfprobePath(path);
    }

    detectFFMPEG() {
        return new Promise((resolve, reject) => {
            ffmpeg().getAvailableCodecs((err, codecs) => {
                return resolve(!err);
            });
        });
    }

    saveQueue() {
        let spread = JSON.stringify([...this._queue]); // Spread the map into a [ ['key', value], ... ] array

        fs.writeFile(path.join(app.getPath('appData'), app.getName(), 'download-queue-v2.json'), spread, 'utf8', (err) => {
            if (err) {
                console.error(err);
            }
        });
    }

    saveHistory() {
        if (!this._appSettings.get('downloads.history')) {
            return;
        }

        fs.writeFile(path.join(app.getPath('appData'), app.getName(), 'downloadHistory.json'), JSON.stringify(this._history), 'utf8', (err) => {
            if (err) {
                console.log(err);
            }
        });
    }

    loadQueue() {
        fs.readFile(path.join(app.getPath('appData'), app.getName(), 'download-queue-v2.json'), 'utf8', (err, data) => {
            if (err) {
                console.error(err);
            } else {
                try {
                    this._queue = new Map<string, Playlist>(JSON.parse(data));
                } catch (err) {
                    console.error(err);
                }
            }

            if (this._queue.size > 0) {
                for (let [key, playlist] of this._queue) {
                    this._emit('download-queued', { uuid: key, display: `${playlist.user.name}: ${playlist.video.id}` });
                }

                this.loop();
            }
        });
    }

    loadHistory() {
        if (!this._appSettings.get('downloads.history')) {
            return;
        }

        fs.readFile(path.join(app.getPath('appData'), app.getName(), 'downloadHistory.json'), 'utf8', (err, data) => {
            if (err) {
                console.log(err);
                this._history = [];
            } else {
                try {
                    this._history = JSON.parse(data);
                } catch (err) {
                    console.log(err);
                    this._history = [];
                }
            }
        });
    }
}