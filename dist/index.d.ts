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
    private _history;
    private _eventCache;
    private _paused;
    private _running;
    private _appSettings;
    private _ffmpegPath;
    events: events.EventEmitter;
    private _emit(channel, obj);
    private _processChunk(url, dest);
    private _getTempFilename(url, uuid);
    private _getLocalFilename(playlist);
    private _getUrlsFromPlaylist(m3u8);
    private _processItem(uuid, playlist);
    private _cleanupTempFiles(uuid);
    init(appSettings: any): void;
    add(playlist: Playlist): string;
    delete(uuid: string): void;
    start(uuid: string): Promise<void>;
    loop(): Promise<void>;
    isPaused(): boolean;
    isRunning(): boolean;
    pause(): void;
    resume(): void;
    load(): void;
    save(): void;
    hasBeenDownloaded(videoid: string): boolean;
    purgeHistory(): void;
    purgeQueue(): void;
    setFfmpegPath(path: string): void;
    setFfprobePath(path: string): void;
    detectFFMPEG(): Promise<{}>;
    saveQueue(): void;
    saveHistory(): void;
    loadQueue(): void;
    loadHistory(): void;
}
