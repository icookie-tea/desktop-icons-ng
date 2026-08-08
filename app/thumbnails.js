/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2021 Sergio Costas (rastersoft@gmail.com)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
export var GnomeDesktop = null;
/* Non-blocking dynamic import: a top-level `await import()` here wedges the
 * GJS promise job queue once Gtk windows start rendering (the module's
 * AsyncModuleExecution chain never drains), which stalls every later
 * microtask and leaves the desktop empty. Resolve lazily instead. */
const gnomeDesktopImport = import('gi://GnomeDesktop?version=4.0').then(
    m => { GnomeDesktop = m.default; },
    () => {});
import GLib from 'gi://GLib';
import * as Constants from './constants.js';
import Gio from 'gi://Gio';
import Gettext from 'gettext';

const _ = Gettext.domain('ding').gettext;

export var ThumbnailLoader = class {
    constructor(desktopManager, codePath) {
        this._timeoutValue = Constants.THUMBNAIL_TIMEOUT_MS;
        this._codePath = codePath;
        this._thumbList = [];
        this._running = false;
        this._thumbnailFactoryNormal = null;
        this._thumbnailFactoryLarge = null;
        this._useAsyncAPI = false;
        // GnomeDesktop loads asynchronously (see gnomeDesktopImport above), so
        // the factories may not exist yet; getThumbnail() awaits this promise.
        this._factoriesReady = gnomeDesktopImport.then(() => {
            if (GnomeDesktop) {
                this._initFactories();
            } else {
                desktopManager.dbusManager.doNotify(
                    _('GnomeDesktop-3.0 GIR file not found'),
                    _('GnomeDesktop-3.0.gir file is missing. Please, install the required package in your system.'));
            }
        });
    }

    _initFactories() {
        this._thumbnailFactoryNormal = GnomeDesktop.DesktopThumbnailFactory.new(GnomeDesktop.DesktopThumbnailSize.NORMAL);
        this._thumbnailFactoryLarge = GnomeDesktop.DesktopThumbnailFactory.new(GnomeDesktop.DesktopThumbnailSize.LARGE);
        if (this._thumbnailFactoryLarge.generate_thumbnail_async) {
            this._useAsyncAPI = true;
        } else {
            this._useAsyncAPI = false;
            print('Failed to detected async api for thumbnails');
        }
    }

    _generateThumbnail(file, resolve) {
        this._thumbList.push([file, resolve]);
        if (!this._running) {
            this._launchNewBuild();
        }
    }

    _launchNewBuild() {
        let file, resolve;
        do {
            if (this._thumbList.length == 0) {
                this._running = false;
                return;
            }
            // if the file disappeared while waiting in the queue, don't refresh the thumbnail
            [file, resolve] = this._thumbList.shift();
            if (file._destroyed) {
                continue;
            }
            if (file.file.query_exists(null)) {
                if (this._thumbnailFactoryLarge.has_valid_failed_thumbnail(file.uri, file.modifiedTime)) {
                    this._resolveThumbnail(file, resolve);
                    continue;
                } else {
                    break;
                }
            }
        } while (true);
        this._running = true;
        if (this._useAsyncAPI) {
            this._createThumbnailAsync(file, resolve);
        } else {
            this._createThumbnailSubprocess(file, resolve);
        }
    }

    _createThumbnailAsync(file, resolve) {
        let fileInfo = file.file.query_info('standard::content-type,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        this._doCancel = new Gio.Cancellable();
        let modifiedTime = fileInfo.get_attribute_uint64('time::modified');
        this._thumbnailFactoryLarge.generate_thumbnail_async(file.uri, fileInfo.get_content_type(), this._doCancel, (obj, res) => {
            this._removeTimeout();
            try {
                let thumbnailPixbuf = obj.generate_thumbnail_finish(res);
                this._thumbnailFactoryLarge.save_thumbnail_async(thumbnailPixbuf, file.uri, modifiedTime, this._doCancel, (obj, res) => {
                    try {
                        obj.save_thumbnail_finish(res);
                    } catch (e) {
                        // A cancelled operation means the timeout handler
                        // already ran _createFailedThumbnailAsync (which
                        // resolves the promise); just bail out.
                        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                            return;
                        }
                        print(`Error while saving thumbnail: ${e.message}\n${e.stack}`);
                        resolve(null);
                        this._launchNewBuild();
                        return;
                    }
                    if (!this._resolveThumbnail(file, resolve)) {
                        // Saved, but the lookup missed (file moved/renamed in
                        // between): resolve with null instead of hanging the
                        // promise forever.
                        resolve(null);
                    }
                    this._launchNewBuild();
                });
            } catch (e) {
                // A cancelled operation means the timeout handler already ran
                // _createFailedThumbnailAsync; don't run it a second time.
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    return;
                }
                print(`Error while creating thumbnail: ${e.message}\n${e.stack}`);
                this._createFailedThumbnailAsync(file, modifiedTime, resolve);
            }
        });
        this._timeoutID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timeoutValue, () => {
            print(`Timeout while generating thumbnail for ${file.displayName}`);
            this._timeoutID = 0;
            this._doCancel.cancel();
            this._createFailedThumbnailAsync(file, modifiedTime, resolve);
            return false;
        });
    }

    _createFailedThumbnailAsync(file, modifiedTime, resolve) {
        this._doCancel = new Gio.Cancellable();
        this._thumbnailFactoryLarge.create_failed_thumbnail_async(file.uri, modifiedTime, this._doCancel, (obj, res) => {
            try {
                obj.create_failed_thumbnail_finish(res);
                this._resolveThumbnail(file, resolve);
            } catch (e) {
                print(`Error while creating failed thumbnail: ${e.message}\n${e.stack}`);
                resolve(null);
            }
            this._launchNewBuild();
        });
    }

    _createThumbnailSubprocess(file, resolve) {
        let args = [];
        args.push(GLib.build_filenamev([this._codePath, 'create-thumbnail.js']));
        args.push(file.path);
        this._proc = new Gio.Subprocess({ argv: args });
        this._proc.init(null);
        this._proc.wait_check_async(null, (source, result) => {
            this._removeTimeout();
            try {
                let result2 = source.wait_check_finish(result);
                if (result2) {
                    let status = source.get_status();
                    if (status == 0) {
                        this._resolveThumbnail(file, resolve);
                    }
                } else {
                    print(`Failed to generate thumbnail for ${file.displayName}`);
                    resolve(null);
                }
            } catch (error) {
                print(`Exception when generating thumbnail for ${file.displayName}: ${error}`);
                resolve(null);
            }
            this._launchNewBuild();
        });
        this._timeoutID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timeoutValue, () => {
            print(`Timeout while generating thumbnail for ${file.displayName}`);
            this._timeoutID = 0;
            this._proc.force_exit();
            this._thumbnailFactoryLarge.create_failed_thumbnail(file.uri, file.modifiedTime);
            return false;
        });
    }

    _removeTimeout() {
        if (this._timeoutID != 0) {
            GLib.source_remove(this._timeoutID);
            this._timeoutID = 0;
        }
    }

    _resolveThumbnail(file, resolve) {
        let thumbnail = this._thumbnailFactoryLarge.lookup(file.uri, file.modifiedTime);
        if (thumbnail == null) {
            thumbnail = this._thumbnailFactoryNormal.lookup(file.uri, file.modifiedTime);
            if (thumbnail === null) {
                return false;
            }
        }
        resolve(thumbnail);
        return true;
    }

    async getThumbnail(file) {
        await this._factoriesReady;
        if (!this._thumbnailFactoryLarge) {
            // GnomeDesktop is unavailable: no thumbnail generation at all.
            return null;
        }
        return new Promise((resolve) => {
            try {
                if (!this._resolveThumbnail(file, resolve)) {
                    if (!this._thumbnailFactoryLarge.has_valid_failed_thumbnail(file.uri, file.modifiedTime) &&
                        this._thumbnailFactoryLarge.can_thumbnail(file.uri, file.attributeContentType, file.modifiedTime)) {
                        this._generateThumbnail(file, resolve);
                    } else {
                        resolve(null);
                    }
                }
            } catch (error) {
                print(`Error when asking for a thumbnail for ${file.displayName}: ${error.message}\n${error.stack}`);
                resolve(null);
            }
        });
    }
};
