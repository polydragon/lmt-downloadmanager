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
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
class DownloadManager {
    constructor() {
        this._queue = new Map();
    }
    _processChunk(url, dest) {
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
            let urls = yield this._getUrlsFromPlaylist(playlist.video.url).catch(err => {
                return reject(`Couldn't get URLs to download: ${err}`);
            });
            let mapper = el => this._processChunk(el, this._getTempFilename(el, uuid)).onProgress(p => { console.log(`onProgress: ${p}`); });
            pMap(urls, mapper, { concurrency: 4 }).then(result => {
                console.log('DONE', result);
                let ff = ffmpeg();
                for (let res of result) {
                    if (res.success) {
                        ff.input(res.local);
                    }
                    else {
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
        return uuid;
    }
    delete(uuid) {
        this._queue.delete(uuid);
    }
    start(uuid) {
        this._processItem(uuid, this._queue.get(uuid));
    }
}
exports.DownloadManager = DownloadManager;
