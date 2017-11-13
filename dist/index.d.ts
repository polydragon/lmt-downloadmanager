/// <reference types="node" />
import events = require('events');
export interface Playlist {
    user: {
        id: string;
        name: string;
    };
    video: {
        id: string;
        title: string;
        time: number;
        url: string;
    };
}
export declare class DownloadManager {
    private _queue;
    private _downloadDirectory;
    private _downloadDirectoryTemp;
    private _downloadMask;
    events: events.EventEmitter;
    private _eventCache;
    private _paused;
    private _running;
    private _emit(channel, obj);
    private _processChunk(url, dest);
    private _getTempFilename(url, uuid);
    private _getLocalFilename(playlist);
    private _getUrlsFromPlaylist(m3u8);
    private _processItem(uuid, playlist);
    private _cleanupTempFiles(uuid);
    init(download: string, temp: string, ffm: string, ffp: string): void;
    add(playlist: Playlist): string;
    delete(uuid: string): void;
    start(uuid: string): Promise<void>;
    loop(): Promise<void>;
    isPaused(): boolean;
    isRunning(): boolean;
    pause(): void;
    resume(): void;
    saveQueue(): void;
}
