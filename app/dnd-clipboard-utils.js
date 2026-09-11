/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2025 Sergio Costas <rastersoft@gmail.com>
 * Some pieces Copyright (C) Sundeep Mediratta (smedius@gmail.com)
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

import * as Enums from './enums.js';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import * as FileUtils from './file-utils.js';
import * as DesktopIconsUtil from './desktop-icons-util.js';

// Prepares a file list for cut or copy
export function manageCutCopy(action) {
    const uriList = fillDragDataGet(Enums.DndTargetInfo.URI_LIST, action.fileList);
    if (!uriList?.length)
        return;

    let clipboard = Gdk.Display.get_default().get_clipboard();
    const textCoder = new TextEncoder();

    let content = action.copy ? 'copy\n' : 'cut\n';
    content += uriList?.replaceAll('\r', '').trim();
    const encodedUriList = textCoder.encode(uriList);

    const gnomeContentProvider = Gdk.ContentProvider.new_for_bytes(Enums.DndTargetInfo.GNOME_CLIPBOARD,
        textCoder.encode(content));
    const textUriListContentProvider = Gdk.ContentProvider.new_for_bytes(Enums.DndTargetInfo.URI_LIST,
        encodedUriList);

    const clipboardContentProvider = Gdk.ContentProvider.new_union([
        gnomeContentProvider,
        textUriListContentProvider,
    ]);
    clipboard.set_content(clipboardContentProvider);
}

// Reads the clipboard for any of the supported mimetypes and returns the first matching type
export async function readClipboard(mimetypes) {
    let clipboard = Gdk.Display.get_default().get_clipboard();
    for (let mimetype of mimetypes) {
        try {
            let [inputStream] = await clipboard.read_async_promise([mimetype], GLib.PRIORITY_DEFAULT, null);
            let bytes = await FileUtils.readAll(inputStream);
            return { mimetype, data: bytes };
        } catch(e) {
        }
    }
    return null;
}

export function processFileList(mimetype, data) {
    const decoder = new TextDecoder();
    const content = decoder.decode(data);

    const retval = {"action": null, "files": []}
    switch(mimetype) {
    case Enums.DndTargetInfo.GNOME_CLIPBOARD:
        let [action, ...clipboarFiles] = content.split('\n');
        retval.action = action;
        clipboarFiles.forEach(file => {
            let file2 = file.replace('\r', '').trim();
            if (file2 != '') {
                retval.files.push(file2);
            }
        });
        break;
    case Enums.DndTargetInfo.DING_ICON_LIST:
    case Enums.DndTargetInfo.URI_LIST:
        let uriFiles = content.split('\n');
        retval.action = 'copy';
        uriFiles.forEach(file => {
            let file2 = file.replace('\r', '').trim();
            if (file2 != '') {
                retval.files.push(file2);
            }
        });
        break;
    case Enums.DndTargetInfo.GNOME_ICON_LIST:
        let gnomeFiles = content.split('\n');
        retval.action = 'copy';
        gnomeFiles.forEach(file => {
            let file2 = file.split('\r')[0].trim();
            if (file2 != '') {
                retval.files.push(file2);
            }
        });
        break;
    }
    return retval;
}

export function fillDragDataGet(target, fileList) {
    if (!fileList)
        return null;

    let uriList = '';

    switch (target) {
        case Enums.DndTargetInfo.GNOME_ICON_LIST:
            for (let fileItem of fileList) {
                uriList += fileItem.uri;
                const coordinates = fileItem.getCoordinates();
                if (coordinates !== null) {
                    uriList += `\r${coordinates[0]}:${coordinates[1]}:${coordinates[2] - coordinates[0] + 1}:${coordinates[3] - coordinates[1] + 1}`;
                }
                uriList += '\r\n';
            }
            return uriList;
        case Enums.DndTargetInfo.DING_ICON_LIST:
        case Enums.DndTargetInfo.URI_LIST:
            uriList = fileList.map(f => f.uri).join('\r\n');
            uriList += '\r\n';
            return uriList;
    }
    return null;
}

export function loadDragData({fileList, specialFilesSelected}) {
    const textCoder = new TextEncoder();

    const uriList = fillDragDataGet(Enums.DndTargetInfo.DING_ICON_LIST, fileList);
    if (!uriList) {
        return null;
    }
    const encodedUriList = textCoder.encode(uriList);
    const dingContentProvider = Gdk.ContentProvider.new_for_bytes(Enums.DndTargetInfo.DING_ICON_LIST,
        encodedUriList);

    if (specialFilesSelected) {
        return dingContentProvider;
    }

    const gnomeUriList = fillDragDataGet(Enums.DndTargetInfo.GNOME_ICON_LIST, fileList);
    if (!gnomeUriList) {
        return null;
    }
    const gnomeContentProvider = Gdk.ContentProvider.new_for_bytes(Enums.DndTargetInfo.GNOME_ICON_LIST,
        textCoder.encode(gnomeUriList));

    const textUriListContentProvider = Gdk.ContentProvider.new_for_bytes(Enums.DndTargetInfo.URI_LIST,
        encodedUriList);

    return Gdk.ContentProvider.new_union([
        dingContentProvider,
        gnomeContentProvider,
        textUriListContentProvider,
    ]);
}

/* Resolves the action a folder-icon drop performs from the actions the drag
 * source offered. Folder drops move when the source allows it (the drop
 * target advertises MOVE in drag-motion, matching Nautilus); GTK collapses
 * COPY|MOVE to ASK, which used to make every folder drop a copy. */
export function resolveDropAction(availableActions) {
    if ((availableActions & Gdk.DragAction.MOVE) !== 0) {
        return Gdk.DragAction.MOVE;
    }
    return Gdk.DragAction.COPY;
}

/* Drops plain text into a folder icon as a new file: the folder counterpart
 * of the desktop's "Dropped Text.txt" behaviour (text is not a URI list, so
 * it must never be handed to Move/CopyURIsRemote). */
export function writeTextIntoFolder(folder, text) {
    const filename = uniqueNameInFolder(folder, DesktopIconsUtil.generateDropFilename(text));
    DesktopIconsUtil.writeDroppedTextFile(text, filename, null, folder);
}

function uniqueNameInFolder(folder, name) {
    if (!folder.get_child(name).query_exists(null)) {
        return name;
    }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.substring(0, dot) : name;
    const suffix = dot > 0 ? name.substring(dot) : '';
    for (let i = 1; i < 1000; i++) {
        const candidate = `${stem} (${i})${suffix}`;
        if (!folder.get_child(candidate).query_exists(null)) {
            return candidate;
        }
    }
    return name;
}

// manages the drop action over an icon (a folder, for example)
export async function manageIconDrop(fileItem, drop, x, y) {
    // Resolve the action before finishing the drop: the caller performs the
    // same action and drop.finish() must report it to the source.
    const dropAction = resolveDropAction(drop.get_actions());
    let dropFinished = false;

    try {
        let [dropData, mimetype] = await drop.read_async_promise(Enums.MIME_TYPES, GLib.PRIORITY_DEFAULT, null);

        drop.finish(dropAction);
        dropFinished = true;

        const data = await FileUtils.readAll(dropData);
        const textDecoder = new TextDecoder();
        const decodedData = textDecoder.decode(data);
        let file_list = [];
        switch (mimetype) {
            case Enums.DndTargetInfo.DING_ICON_LIST:
            case Enums.DndTargetInfo.URI_LIST:
                for (let item of decodedData.split("\n")) {
                    if (item !== '') {
                        file_list.push(item.replace('\r', ''));
                    }
                }
                break;
            case Enums.DndTargetInfo.GNOME_ICON_LIST:
                for (let item of decodedData.split("\n")) {
                    let item2 = item.split("\r")[0];
                    if (item2 !== '') {
                        file_list.push(item2);
                    }
                }
                break;
            case Enums.DndTargetInfo.TEXT_PLAIN:
            case Enums.DndTargetInfo.TEXT_PLAIN_UTF8:
                file_list = [decodedData];
                mimetype = Enums.DndTargetInfo.TEXT_PLAIN;
                break;
            default:
                console.log(`Unknown mime type for DnD: ${mimetype}`);
                break;
        }
        return {
            'action': dropAction,
            'mimetype': mimetype,
            'filelist': file_list
        };
    } catch (e) {
        console.error(e);
        if (!dropFinished) {
            drop.finish(0);
        }
    }
    return null;
}
