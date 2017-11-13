"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const wget = require('wget-improved');
const pMap = require('p-map');
const PProgress = require('p-progress');
const axios = require('axios');
const path = require("path");
const fs = require("fs-extra");
const ffmpeg = require("fluent-ffmpeg");
const events = require("events");
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
class DownloadManager {
    constructor() {
        this._queue = new Map();
        this.events = new (events.EventEmitter)();
    }
    _emit(channel, obj) {
        if (this._eventCache && (this._eventCache.channel === channel && JSON.stringify(this._eventCache.obj) === JSON.stringify(obj))) {
            return;
        }
        else {
            this._eventCache = {
                channel: channel,
                obj: obj
            };
        }
        this.events.emit(channel, obj);
    }
    _processChunk(url, dest) {
        return new PProgress((resolve, reject, progress) => {
            fs.ensureDirSync(path.dirname(dest));
            let download = wget.download(url, dest);
            download.on('error', (err) => {
                return resolve({ success: false, error: err, local: dest });
            });
            download.on('start', (filesize) => {
            });
            download.on('end', (output) => {
                return resolve({ success: true, local: dest });
            });
            download.on('progress', (p) => {
                progress({ chunk: path.basename(url, '.ts'), progress: p });
            });
        });
    }
    _getTempFilename(url, uuid) {
        return path.join(this._downloadDirectoryTemp, uuid, path.basename(url));
    }
    _getLocalFilename(playlist) {
        let defaultPath = path.join(this._downloadDirectory, path.basename(playlist.video.url).replace("m3u8", "mp4"));
        return defaultPath;
    }
    _getUrlsFromPlaylist(m3u8) {
        return new Promise((resolve, reject) => {
            return axios
                .get(m3u8)
                .then(response => {
                let playlist = [], baseURL = path.dirname(m3u8);
                for (let line of (response.data.split('\n'))) {
                    line = line.trim();
                    if (line.length == 0 || line[0] == '#') {
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
    _processItem(uuid, playlist) {
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            this._emit('download-started', { uuid: uuid });
            let chunkProgress = new Map();
            this._emit('download-status', { uuid: uuid, status: 'Getting chunks to download...' });
            let urls = yield this._getUrlsFromPlaylist(playlist.video.url).catch(err => {
                return reject(`Couldn't get URLs to download: ${err}`);
            });
            let mapper = el => this._processChunk(el, this._getTempFilename(el, uuid)).onProgress(p => {
                chunkProgress.set(p.chunk, p.progress);
                let total = 0;
                for (let val of chunkProgress.values()) {
                    if (val)
                        total += val;
                }
                total = Math.floor((total / urls.length) * 100);
                this._emit('download-progress', { uuid: uuid, percent: total });
            });
            this._emit('download-status', { uuid: uuid, status: 'Downloading chunks' });
            pMap(urls, mapper, { concurrency: 4 }).then(result => {
                this._emit('download-status', { uuid: uuid, status: 'Merging chunks' });
                let ff = ffmpeg();
                for (let res of result) {
                    if (res.success) {
                        ff.input(res.local);
                    }
                    else {
                        return reject(`Failed to download at least one file`);
                    }
                }
                ff
                    .on('end', () => {
                    this._emit('download-completed', { uuid: uuid });
                    return resolve();
                })
                    .on('error', (err) => {
                    this._emit('download-errored', { uuid: uuid });
                    return reject(err);
                })
                    .mergeToFile(this._getLocalFilename(playlist));
            });
        }));
    }
    init(download, temp, ffm, ffp) {
        this._downloadDirectory = download;
        this._downloadDirectoryTemp = temp;
        ffmpeg().setFfmpegPath(ffm);
        ffmpeg().setFfprobePath(ffp);
    }
    add(playlist) {
        let uuid = uuidv4();
        this._queue.set(uuid, playlist);
        this._emit('download-queued', { uuid: uuid, display: `${playlist.user.name}: ${playlist.video.id}` });
        return uuid;
    }
    delete(uuid) {
        this._queue.delete(uuid);
        this._emit('download-deleted', { uuid: uuid });
    }
    start(uuid) {
        this._processItem(uuid, this._queue.get(uuid));
    }
}
exports.DownloadManager = DownloadManager;
