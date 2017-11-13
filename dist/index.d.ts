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
    private _processChunk(url, dest);
    private _getTempFilename(url, uuid);
    private _getLocalFilename(playlist);
    private _getUrlsFromPlaylist(m3u8);
    private _processItem(uuid, playlist);
    init(download: string, temp: string, ffm: string, ffp: string): void;
    add(playlist: Playlist): string;
    delete(uuid: string): void;
    start(uuid: string): void;
}
