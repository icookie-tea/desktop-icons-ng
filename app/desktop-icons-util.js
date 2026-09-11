/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2019 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
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
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import * as Prefs from './preferences.js';
import * as Enums from './enums.js';
import Gettext from 'gettext';
import * as ShowErrorPopup from './show-error-popup.js';

const _ = Gettext.domain('ding').gettext;

/**
 *
 * @param context
 * @param modifiersToCheck
 */
export function getModifiersInDnD(context, modifiersToCheck) {
    let device = context.get_device();
    let display = device.get_display();
    let keymap = Gdk.Keymap.get_for_display(display);
    let modifiers = keymap.get_modifier_state();
    return (modifiers & modifiersToCheck) != 0;
}

/**
 *
 */
export function getDesktopDir() {
    let desktopPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
    return Gio.File.new_for_commandline_arg(desktopPath);
}

/**
 *
 */
export function getScriptsDir() {
    let scriptsDir = GLib.build_filenamev([GLib.get_home_dir(), Enums.NAUTILUS_SCRIPTS_DIR]);
    return Gio.File.new_for_commandline_arg(scriptsDir);
}

/**
 *
 */
export function getTemplatesDir() {
    let templatesDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_TEMPLATES);
    if ((templatesDir == GLib.get_home_dir()) || (templatesDir == null)) {
        return null;
    }
    return Gio.File.new_for_commandline_arg(templatesDir);
}

/**
 * Returns the state of the modifier keys in the controller
 */
export function getControllerStatus(controller) {
    let state = controller.get_current_event_state();
    return {
        shift: !!(state & Gdk.ModifierType.SHIFT_MASK),
        control: !!(state & Gdk.ModifierType.CONTROL_MASK),
        alt: !!(state & Gdk.ModifierType.ALT_MASK),
        super: !!(state & Gdk.ModifierType.SUPER_MASK)
    };
}

/**
 *
 * @param value
 * @param min
 * @param max
 */
export function clamp(value, min, max) {
    return Math.max(Math.min(value, max), min);
}

/**
 *
 * @param commandLine
 * @param environ
 */
export function spawnCommandLine(commandLine, environ = null) {
    try {
        let [, argv] = GLib.shell_parse_argv(commandLine);
        trySpawn(null, argv, environ);
    } catch (err) {
        print(`${commandLine} failed with ${err}`);
    }
}

/**
 *
 * @param workdir
 * @param command
 */
export function launchTerminal(workdir, command) {
    const settings = new Gio.Settings({ schema_id: Enums.TERMINAL_SCHEMA });
    const settingsExec = settings.get_string(Enums.EXEC_KEY);
    const terminals = ['xdg-terminal-exec', settingsExec, 'kgx', 'gnome-terminal', 'ptyxis'];
    for (const name of terminals) {
        const exec = GLib.find_program_in_path(name);
        if (exec !== null) {
            const argv = [exec];
            if (workdir && (name === 'xdg-terminal-exec')) {
                argv.push(`--dir=${workdir}`);
            }
            if (command) {
                argv.push('-e');
                argv.push(command);
            }
            try {
                trySpawn(workdir, argv, null);
                return;
            }
            catch (err) {
                print(`Starting ${exec} failed with ${err}`);
            }
        }
    }
    new ShowErrorPopup.ShowErrorPopup(
        _('No Terminal'),
        _('Cannot open a terminal, because none is installed or configured properly.'),
        true
    );
}

/**
 *
 * @param workdir
 * @param argv
 * @param environ
 */
export function trySpawn(workdir, argv, environ = null) {
    /* The following code has been extracted from GNOME Shell's
     * source code in Misc.Util.trySpawn function and modified to
     * set the working directory.
     *
     * https://gitlab.gnome.org/GNOME/gnome-shell/blob/gnome-3-30/js/misc/util.js
     */

    var pid;
    try {
        [pid] = GLib.spawn_async(workdir, argv, environ,
            GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
            null);
    } catch (err) {
        /* Rewrite the error in case of ENOENT */
        if (err.matches(GLib.SpawnError, GLib.SpawnError.NOENT)) {
            throw new GLib.SpawnError({
                code: GLib.SpawnError.NOENT,
                message: _('Command not found'),
            });
        } else if (err instanceof GLib.Error) {
            // The exception from gjs contains an error string like:
            //   Error invoking GLib.spawn_command_line_async: Failed to
            //   execute child process "foo" (No such file or directory)
            // We are only interested in the part in the parentheses. (And
            // we can't pattern match the text, since it gets localized.)
            let message = err.message.replace(/.*\((.+)\)/, '$1');
            throw new err.constructor({
                code: err.code,
                message,
            });
        } else {
            throw err;
        }
    }
    // Dummy child watch; we don't want to double-fork internally
    // because then we lose the parent-child relationship, which
    // can break polkit.  See https://bugzilla.redhat.com//show_bug.cgi?id=819275
    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => { });
}

/**
 *
 */
export function getFilteredEnviron() {
    let environ = [];
    for (let env of GLib.get_environ()) {
        /* It's a must to remove the WAYLAND_SOCKET environment variable
            because, under Wayland, DING uses an specific socket to allow the
            extension to detect its windows. But the scripts must run under
            the normal socket */
        if (env.startsWith('WAYLAND_SOCKET=')) {
            continue;
        }
        environ.push(env);
    }
    return environ;
}

/**
 *
 * @param x
 * @param y
 * @param x2
 * @param y2
 */
export function distanceBetweenPoints(x, y, x2, y2) {
    return Math.pow(x - x2, 2) + Math.pow(y - y2, 2);
}

/**
 *
 */
export function getExtraFolders() {
    let extraFolders = [];
    if (Prefs.desktopSettings.get_boolean('show-home')) {
        extraFolders.push([Gio.File.new_for_commandline_arg(GLib.get_home_dir()), Enums.FileType.USER_DIRECTORY_HOME]);
    }
    if (Prefs.desktopSettings.get_boolean('show-trash')) {
        extraFolders.push([Gio.File.new_for_uri('trash:///'), Enums.FileType.USER_DIRECTORY_TRASH]);
    }
    return extraFolders;
}

/**
 *
 * @param volumeMonitor
 */
export function getMounts(volumeMonitor) {
    let showVolumes = Prefs.desktopSettings.get_boolean('show-volumes');
    let showNetwork = Prefs.desktopSettings.get_boolean('show-network-volumes');

    try {
        var mounts = volumeMonitor.get_mounts();
    } catch (e) {
        print(`Failed to get the list of mounts with ${e}`);
        return [];
    }

    let result = [];
    let uris = [];
    for (let mount of mounts) {
        try {
            let isDrive = (mount.get_drive() != null) || (mount.get_volume() != null);
            let uri = mount.get_default_location().get_uri();
            if (((isDrive && showVolumes) || (!isDrive && showNetwork)) && !uris.includes(uri)) {
                result.push([mount.get_default_location(), Enums.FileType.EXTERNAL_DRIVE, mount]);
                uris.push(uri);
            }
        } catch (e) {
            print(`Failed with ${e} while getting volume`);
        }
    }
    return result;
}

/**
 *
 * @param filename
 * @param opts
 */
export function getFileExtensionOffset(filename, opts = { 'isDirectory': false }) {
    let offset = filename.length;
    let extension = '';
    if (!opts.isDirectory) {
        const doubleExtensions = ['.gz', '.bz2', '.sit', '.Z', '.bz', '.xz', '.zst'];
        for (const item of doubleExtensions) {
            if (filename.endsWith(item)) {
                offset -= item.length;
                extension = filename.substring(offset);
                filename = filename.substring(0, offset);
                break;
            }
        }
        let lastDot = filename.lastIndexOf('.');
        if (lastDot > 0) {
            offset = lastDot;
            extension = filename.substring(offset) + extension;
            filename = filename.substring(0, offset);
        }
    }
    return { offset, 'basename': filename, extension };
}

export function generateDropFilename(text) {
    const MAX_LEN = 64;
    const MIN_LEN = 8;

    let flat = text.replace(/[\n\r\t]/g, ' ').trim();
    flat = flat.substring(0, MAX_LEN);
    flat = flat.replace(/[<>:"\\\/|?*\x00-\x1f]/g, '-');
    flat = flat.replace(/-+/g, '-');
    flat = flat.replace(/^-+|-+$/g, '').trim();

    if (flat.length >= MIN_LEN) {
        return `${flat}.txt`;
    }

    return _("Dropped Text.txt");
}

export function writeDroppedTextFile(text, filename, dropCoordinates) {
    let desktopDir = getDesktopDir();
    let file = desktopDir.get_child(filename);

    let content = text;
    if (!content.endsWith('\n')) {
        content += '\n';
    }

    file.replace_contents(content, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    if (dropCoordinates != null) {
        let info = new Gio.FileInfo();
        info.set_attribute_string('metadata::nautilus-drop-position',
            `${dropCoordinates[0]},${dropCoordinates[1]}`);
        try {
            file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            // File may have been deleted or filesystem may not support metadata attributes
        }
    }
}

/**
 *
 * @param window
 * @param modal
 */
export function windowHidePagerTaskbarModal(window, modal) {
    let title = window.get_title();
    if (title == null) {
        title = '';
    }
    if (modal) {
        title += '  ';
    } else {
        title += ' ';
    }
    window.set_title(title);
    window.set_modal(modal);
    window.grab_focus();
}

/**
 *
 * @param ms
 */
export function waitDelayMs(ms) {
    return new Promise((resolve, reject) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return false;
        });
    });
}

/* Retry backoff (ms) for defensive monitor creation. */
const MONITOR_RETRY_DELAYS_MS = [2000, 5000, 10000, 30000];

/**
 * Creates a directory monitor without ever throwing.
 *
 * Gio.File.monitor_directory() can fail transiently — typically inotify
 * instance exhaustion, reported as "Unable to find default local file monitor
 * type" (seen in this machine's journal, also from gnome-control-center).
 * Letting that exception escape aborted the calling constructor; for
 * DesktopManager it ran after mainApp.hold(), so the DING process stayed
 * alive with no desktop and the shell extension never relaunched it (audit
 * 2026-09-11). Retries with backoff and hands every successful monitor to
 * `onMonitor`, which owns signal wiring and storage.
 *
 * @param {Gio.File} file directory to monitor
 * @param {object} opts
 * @param {Gio.FileMonitorFlags} opts.flags
 * @param {function(Gio.FileMonitor)} opts.onMonitor
 * @param {string} [opts.label] human-readable name used in the log
 * @param {number} [opts.rateLimit] forwarded to set_rate_limit()
 * @param {number[]} [opts.retryDelaysMs] test seam for the backoff schedule
 */
export function monitorDirectoryDefensively(file, { flags, onMonitor, label = '', rateLimit = 0, retryDelaysMs = MONITOR_RETRY_DELAYS_MS }) {
    const name = label || file.get_path() || 'directory';
    let attempt = 0;
    const tryCreate = () => {
        let monitor = null;
        try {
            monitor = file.monitor_directory(flags, null);
        } catch (e) {
            print(`Failed to monitor ${name}: ${e.message}`);
        }
        if (monitor) {
            if (rateLimit > 0) {
                monitor.set_rate_limit(rateLimit);
            }
            onMonitor(monitor);
            return;
        }
        if (attempt >= retryDelaysMs.length) {
            print(`Giving up monitoring ${name} after ${retryDelaysMs.length} retries`);
            return;
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, retryDelaysMs[attempt++], () => {
            tryCreate();
            return GLib.SOURCE_REMOVE;
        });
    };
    tryCreate();
}
