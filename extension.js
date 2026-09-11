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
'use strict';
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import Meta from 'gi://Meta'
import St from 'gi://St'

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js'

import * as EmulateX11 from './emulate-x11-window-type.js';
import * as VisibleArea from './visible-area.js';
import * as ShellOverride from './gnome-shell-override.js';

/* Verbose diagnostics only when DING_DEBUG is set (avoids journal spam on
 * every monitor geometry change). */
const debugLog = (...args) => {
    if (GLib.getenv('DING_DEBUG') !== null)
        console.log(...args);
};

/* Timeouts (microseconds/milliseconds) for process launch/relaunch handling. */
const PROCESS_CRASH_WINDOW_US = 1000000; // if the process died within 1s of launch
const WINDOW_MAP_TIMEOUT_MS = 6000;      // kill + relaunch if no window maps in time
const PROCESS_KILL_TIMEOUT_MS = 2000;    // SIGTERM -> SIGKILL grace period

export default class DING extends Extension {
    constructor(metadata) {
        super(metadata);
        this.DesktopIconsUsableArea = null;
        this.data = {};
        this.data.isEnabled = false;
        this.data.launchDesktopId = 0;
        this.data.currentProcess = null;

        /* The constructor of the EmulateX11 class only initializes some
        * internal properties, but nothing else. In fact, it has its own
        * enable() and disable() methods. That's why it could have been
        * created here, in init(). But since the rule seems to be NO CLASS
        * CREATION IN INIT UNDER NO CIRCUMSTANCES...
        */
        this.data.x11Manager = null;
        this.data.visibleArea = null;
        this.data.gnomeShellOverride = null;

        /* Ensures that there aren't "rogue" processes.
        * This is a safeguard measure for the case of Gnome Shell being
        * relaunched (killall -3 gnome-shell, a shell crash restart, or a
        * fresh login) while the old DING process is still alive, to kill
        * any stale instance. It runs before any desktop process is launched
        * (launchDesktop() waits for the sweep): starting a second instance
        * first could let the stale one win the application name.
        *
        * The sweep walks every process in /proc and used to run
        * synchronously here, blocking Shell startup. It is deferred to an
        * idle now (audit 2026-09-11).
        */
        this.data.procSweepDone = false;
        this.data.launchPending = false;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                this.doKillAllOldDesktopProcesses();
            } catch (e) {
                // Never leave launchDesktop() waiting forever.
                debugLog(`[proc] stale-instance sweep failed: ${e.message}`);
            }
            this.data.procSweepDone = true;
            if (this.data.launchPending) {
                this.data.launchPending = false;
                // disable() may have run while the sweep was pending.
                if (this.data.isEnabled) {
                    this.launchDesktop();
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    enable() {
        if (!this.data.x11Manager) {
            this.data.x11Manager = new EmulateX11.EmulateX11WindowType();
        }
        if (!this.DesktopIconsUsableArea) {
            this.DesktopIconsUsableArea = new VisibleArea.VisibleArea(() => Main.layoutManager.primaryIndex);
            this.data.visibleArea = this.DesktopIconsUsableArea;
        }
        if (!this.data.gnomeShellOverride) {
            this.data.gnomeShellOverride = new ShellOverride.GnomeShellOverride();
            this.data.gnomeShellOverride.enable();
        }
        // If the desktop is still starting up, we wait until it is ready
        if (Main.layoutManager._startingUp) {
            this.data.startupPreparedId = Main.layoutManager.connect('startup-complete', () => this.innerEnable());
        } else {
            this.data.startupPreparedId = null;
            this.innerEnable();
        }
    }

    disable() {
        this.DesktopIconsUsableArea = null;
        this.data.isEnabled = false;
        this.killCurrentProcess();
        this.data.x11Manager.disable();
        this.data.visibleArea.disable();
        if (this.data.gnomeShellOverride) {
            this.data.gnomeShellOverride.disable();
            this.data.gnomeShellOverride = null;
        }

        if (this.data.disableTimerId) {
            this.data.disableTimer.disconnect(this.data.disableTimerId);
            this.data.disableTimerId = 0;
            this.data.disableTimer = undefined;
        }

        this.data.desktopGeometry = undefined;

        // disconnect signals only if connected
        if (this.data.dbusConnectionGroupId) {
            this.data.dbusConnection.unexport_action_group(this.data.dbusConnectionGroupId);
            this.data.dbusConnectionGroupId = 0;
            this.data.dbusConnection = undefined;
        }

        if (this.data.dbusConnectionId) {
            Gio.bus_unown_name(this.data.dbusConnectionId);
            this.data.dbusConnectionId = 0;
        }
        this.data.actionGroup = undefined;

        if (this.data.scaleFactorId) {
            St.ThemeContext.get_for_stage(global.stage).disconnect(this.data.scaleFactorId);
            this.data.scaleFactorId = 0;
        }
        if (this.data.visibleAreaId) {
            this.data.visibleArea.disconnect(this.data.visibleAreaId);
            this.data.visibleAreaId = 0;
        }
        if (this.data.startupPreparedId) {
            Main.layoutManager.disconnect(this.data.startupPreparedId);
            this.data.startupPreparedId = 0;
        }
        if (this.data.monitorsChangedId) {
            Main.layoutManager.disconnect(this.data.monitorsChangedId);
            this.data.monitorsChangedId = 0;
        }
        if (this.data.workareasChangedId) {
            global.display.disconnect(this.data.workareasChangedId);
            this.data.workareasChangedId = 0;
        }
        if (this.data.sizeChangedId) {
            global.window_manager.disconnect(this.data.sizeChangedId);
            this.data.sizeChangedId = 0;
        }
    }

    /**
     * The true code that configures everything and launches the desktop program
     */
    innerEnable() {
        if (this.data.startupPreparedId !== null) {
            Main.layoutManager.disconnect(this.data.startupPreparedId);
            this.data.startupPreparedId = null;
        }

        // Exit the overview mode on startup
        Main.overview.hide();

        this.data.x11Manager.enable();

        /*
        * If the desktop geometry changes (because a new monitor has been added, for example),
        * we kill the desktop program. It will be relaunched automatically with the new geometry,
        * thus adapting to it on-the-fly.
        */
        this.data.monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this.updateDesktopGeometry());
        /*
        * Any change in the workareas must be detected too, for example if the used size
        * changes.
        */
        this.data.workareasChangedId = global.display.connect('workareas-changed', () => this.updateDesktopGeometry());

        /*
        * This callback allows to detect a change in the working area (like when changing the Scale value)
        */
        this.data.visibleAreaId = this.data.visibleArea.connect('updated-usable-area', () => this.updateDesktopGeometry());

        /*
         * This callback allows to detect a change in the scale factor, to adapt the desktop geometry to it.
         */
        this.data.scaleFactorId = St.ThemeContext.get_for_stage(global.stage).connect('notify::scale-factor',
            () => this.updateDesktopGeometry());

        this.data.isEnabled = true;
        if (this.data.launchDesktopId) {
            GLib.source_remove(this.data.launchDesktopId);
            // Zero it: a later killCurrentProcess()/doRelaunch() must not try
            // to remove this already-removed (and possibly recycled) source
            // id (audit 2026-09-11).
            this.data.launchDesktopId = 0;
        }

        this.data.dbusConnectionId = Gio.bus_own_name(Gio.BusType.SESSION, 'com.rastersoft.dingextension', Gio.BusNameOwnerFlags.NONE, null, (connection, name) => {
            // disable() may have run while the name was being acquired (fast
            // enable/disable cycles, session shutdown): never launch a
            // desktop process that nothing would manage afterwards.
            if (!this.data.isEnabled) {
                return;
            }
            this.data.dbusConnection = connection;

            this.data.disableTimer = new Gio.SimpleAction({
                name: 'disableTimer',
            });
            this.data.desktopGeometry = Gio.SimpleAction.new_stateful('desktopGeometry', new GLib.VariantType('av'), this.getDesktopGeometry());
            this.data.desktopGeometry.set_enabled(true);
            this.data.disableTimerId = this.data.disableTimer.connect('activate', () => {
                if (this.data.currentProcess && this.data.currentProcess.subprocess) {
                    this.data.currentProcess.cancel_timer();
                }
            });
            this.data.actionGroup = new Gio.SimpleActionGroup();
            this.data.actionGroup.add_action(this.data.disableTimer);
            this.data.actionGroup.add_action(this.data.desktopGeometry);

            this.data.dbusConnectionGroupId = this.data.dbusConnection.export_action_group(
                '/com/rastersoft/dingextension/control',
                this.data.actionGroup
            );
            this.launchDesktop();
        }, null);
    }

    /**
     * Kills the current desktop program
     */
    killCurrentProcess() {
        if (this.data.launchDesktopId) {
            GLib.source_remove(this.data.launchDesktopId);
            this.data.launchDesktopId = 0;
        }

        // kill the desktop program. It will be reloaded automatically.
        const runningProcess = this.data.currentProcess;
        if (runningProcess && runningProcess.subprocess) {
            runningProcess.cancel_timer();
            runningProcess.cancellable.cancel();
            runningProcess.subprocess.send_signal(15);
            // The app's main loop can be blocked (a long copy, a hung gvfs
            // call): escalate once instead of leaving a stale instance that
            // keeps the D-Bus name and the desktop windows. Only while the
            // child has not been reaped — after that its pid could belong to
            // another process (audit 2026-09-11).
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROCESS_KILL_TIMEOUT_MS, () => {
                if (!runningProcess.reaped && runningProcess.subprocess) {
                    debugLog('[DING] desktop process ignored SIGTERM, sending SIGKILL');
                    runningProcess.subprocess.send_signal(9);
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        this.data.currentProcess = null;
        this.data.x11Manager.setWaylandClient(null);
    }

    /**
     *
     */
    updateDesktopGeometry() {
        if (this.data.actionGroup && (Main.layoutManager.monitors.length != 0)) {
            debugLog(`[DING] updateDesktopGeometry triggered. monitors.length=${Main.layoutManager.monitors.length}, primaryIndex=${Main.layoutManager.primaryIndex}`);
            for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
                let m = Main.layoutManager.monitors[i];
                debugLog(`[DING]   monitor[${i}]: x=${m.x}, y=${m.y}, w=${m.width}, h=${m.height}, scale=${m.scale}, primary=${i === Main.layoutManager.primaryIndex}`);
            }
            this.data.actionGroup.change_action_state('desktopGeometry', this.getDesktopGeometry());
            this.data.x11Manager.refreshWindowsPosition();
        } else {
            debugLog(`[DING] updateDesktopGeometry SKIPPED: actionGroup=${!!this.data.actionGroup}, monitors.length=${Main.layoutManager.monitors.length}`);
        }
    }

    /**
     *
     */
    getDesktopGeometry() {
        let desktopVariantList = [];
        let desktopList = [];
        const ws = global.workspace_manager.get_active_workspace();
        const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
        debugLog(`[DING] getDesktopGeometry: monitors.length=${Main.layoutManager.monitors.length}, primaryIndex=${Main.layoutManager.primaryIndex}, scaleFactor=${scaleFactor}`);
        for (let monitorIndex = 0; monitorIndex < Main.layoutManager.monitors.length; monitorIndex++) {
            let area = this.data.visibleArea.getMonitorGeometry(ws, monitorIndex);
            let monitorData = {
                'x': area.x,
                'y': area.y,
                'width': area.width,
                'height': area.height,
                'scaleFactor': scaleFactor,
                'marginTop': area.marginTop,
                'marginBottom': area.marginBottom,
                'marginLeft': area.marginLeft,
                'marginRight': area.marginRight,
                monitorIndex,
                'primaryMonitor': Main.layoutManager.primaryIndex,
                'windowMarginTop': area.windowMarginTop,
                'windowMarginBottom': area.windowMarginBottom,
                'windowMarginLeft': area.windowMarginLeft,
                'windowMarginRight': area.windowMarginRight,
            };
            debugLog(`[DING]   monitorData[${monitorIndex}]: x=${area.x}, y=${area.y}, w=${area.width}, h=${area.height}, monitorIndex=${monitorIndex}, primaryMonitor=${Main.layoutManager.primaryIndex}, margins=[T:${area.marginTop},B:${area.marginBottom},L:${area.marginLeft},R:${area.marginRight}]`);
            let desktopListElement = new GLib.Variant('a{sd}', monitorData);
            desktopVariantList.push(desktopListElement);
            desktopList.push(monitorData);
        }
        this.data.x11Manager.setMonitorData(desktopList);
        debugLog(`[DING] getDesktopGeometry DONE: ${desktopList.length} monitors sent via D-Bus`);
        return new GLib.Variant('av', desktopVariantList);
    }

    /**
     * This function checks all the processes in the system and kills those
     * that are a desktop manager from the current user (but not others).
     * This allows to avoid having several ones in case gnome shell resets,
     * or other odd cases. It requires the /proc virtual filesystem, but
     * doesn't fail if it doesn't exist.
     */
    doKillAllOldDesktopProcesses() {
        const procFolder = Gio.File.new_for_path('/proc');
        if (!procFolder.query_exists(null)) {
            return;
        }

        // The sweep can now run after enable(): never kill the instance this
        // extension just launched.
        const currentPid = this.data.currentProcess?.subprocess?.get_identifier?.() ?? null;

        let fileEnum = procFolder.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = fileEnum.next_file(null))) {
            try {
                let filename = info.get_name();
                if (!filename) {
                    break;
                }
                let processPath = GLib.build_filenamev(['/proc', filename, 'cmdline']);
                let processUser = Gio.File.new_for_path(processPath);
                if (!processUser.query_exists(null)) {
                    continue;
                }
                let [binaryData] = processUser.load_bytes(null);
                let contents = '';
                let readData = binaryData.get_data();
                for (let i = 0; i < readData.length; i++) {
                    if (readData[i] < 32) {
                        contents += ' ';
                    } else {
                        contents += String.fromCharCode(readData[i]);
                    }
                }
                // The shebang `#!/usr/bin/env -S gjs --module` makes /proc/<pid>/cmdline
                // read "gjs --module <path>/ding.js -E -P ..." — match on the script
                // path alone (includes), not on a "gjs <path>" prefix, otherwise
                // the ESM-era processes are never recognized and stale DING
                // processes survive Shell restarts (two processes then race for
                // the com.rastersoft.ding application name).
                let path = GLib.build_filenamev([this.path, 'app', 'ding.js']);
                if (contents.includes(path) && filename !== currentPid) {
                    let proc = new Gio.Subprocess({ argv: ['/bin/kill', filename] });
                    proc.init(null);
                    proc.wait(null);
                }
            } catch (e) {
                // PIDs come and go while we walk /proc: a process exiting
                // between query_exists() and load_bytes() must not abort the
                // Extension constructor — that would leave the whole session
                // without a desktop (audit 2026-09-11).
                debugLog(`[proc] skipping ${info.get_name()}: ${e.message}`);
            }
        }
    }

    /**
     *
     * @param reloadTime
     */
    doRelaunch(reloadTime) {
        this.data.currentProcess = null;
        this.data.x11Manager.setWaylandClient(null);
        if (this.data.isEnabled) {
            if (this.data.launchDesktopId) {
                GLib.source_remove(this.data.launchDesktopId);
            }
            this.data.launchDesktopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, reloadTime, () => {
                this.data.launchDesktopId = 0;
                this.launchDesktop();
                return false;
            });
        }
    }

    /**
     * Launches the desktop program, passing to it the current desktop geometry for each monitor
     * and the path where it is stored. It also monitors it, to relaunch it in case it dies or is
     * killed. Finally, it reads STDOUT and STDERR and redirects them to the journal, to help to
     * debug it.
     */
    launchDesktop() {
        if (!this.data.procSweepDone) {
            // The stale-instance sweep is still pending: starting a second
            // instance now could let the old one win the application name.
            this.data.launchPending = true;
            return;
        }
        console.log('Launching DING process');
        let argv = [];
        argv.push(GLib.build_filenamev([this.path, 'app', 'ding.js']));
        // Specify that it must work as true desktop
        argv.push('-E');
        // The path. Allows the program to find translations, settings and modules.
        argv.push('-P');
        argv.push(GLib.build_filenamev([this.path, 'app']));

        this.data.currentProcess = new LaunchSubprocess(0, 'DING');
        this.data.currentProcess.set_cwd(GLib.get_home_dir());
        if (this.data.currentProcess.spawnv(argv) === null) {
            this.doRelaunch(1000);
            return;
        }
        this.data.x11Manager.setWaylandClient(this.data.currentProcess);
        this.data.launchTime = GLib.get_monotonic_time();
        const launchedProcess = this.data.currentProcess;
        launchedProcess.reaped = false;

        /*
        * If the desktop process dies, wait 100ms and relaunch it, unless the exit status is different than
        * zero, in which case it will wait one second. This is done this way to avoid relaunching the desktop
        * too fast if it has a bug that makes it fail continuously, avoiding filling the journal too fast.
        */
        this.data.currentProcess.subprocess.wait_async(null, (obj, res) => {
            // Reaped: the pid can be recycled from now on, so the SIGKILL
            // escalation in killCurrentProcess() must not use it anymore.
            launchedProcess.reaped = true;
            let delta = GLib.get_monotonic_time() - this.data.launchTime;
            if (delta < PROCESS_CRASH_WINDOW_US) {
                // If the process is dying over and over again, ensure that it isn't respawn faster than once per second
                var reloadTime = 1000;
            } else {
                // but if the process just died after having run for at least one second, reload it ASAP
                var reloadTime = 1;
            }
            obj.wait_finish(res);
            if (!this.data.currentProcess || obj !== this.data.currentProcess.subprocess) {
                return;
            }
            if (obj.get_if_exited()) {
                obj.get_exit_status();
            }
            this.doRelaunch(reloadTime);
        });
    }
}

/**
 * This class encapsulates the code to launch a subprocess that can detect whether a window belongs to it
 * It only accepts to do it under Wayland, because under X11 there is no need to do these tricks
 *
 * It is compatible with https://gitlab.gnome.org/GNOME/mutter/merge_requests/754 to simplify the code
 *
 * @param {int} flags Flags for the SubprocessLauncher class
 * @param {string} process_id An string id for the debug output
 */
class LaunchSubprocess {
    constructor(flags, process_id) {
        this._process_id = process_id;
        this.cancellable = new Gio.Cancellable();
        this._launcher = new Gio.SubprocessLauncher({ flags: flags | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE });
        this.subprocess = null;
        this.reaped = false;
        this.process_running = false;
        this._launch_timer = 0;
        this._waiting_for_windows = 0;
    }

    spawnv(argv) {
        try {
            // New API introduced in https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/4491
            this._waylandClient = Meta.WaylandClient.new_subprocess (global.context, this._launcher, argv);
            this.subprocess = this._waylandClient.get_subprocess();
        } catch (e) {
            this.subprocess = null;
            console.log(`Error while trying to launch DING process: ${e.message}\n${e.stack}`);
        }
        this._launcher.close();
        this._launcher = null;
        if (this.subprocess) {
            /*
                 * It reads STDOUT and STDERR and sends it to the journal using console.log(). This allows to
                 * have any error from the desktop app in the same journal than other extensions. Every line from
                 * the desktop program is prepended with the "process_id" parameter sent in the constructor.
                 */
            this._dataInputStream = Gio.DataInputStream.new(this.subprocess.get_stdout_pipe());
            this.read_output();
            this.subprocess.wait_async(this.cancellable, () => {
                this.process_running = false;
                this._dataInputStream = null;
                this.cancellable = null;
                this.cancel_timer();
            });
            this.process_running = true;
            if (Main.layoutManager.monitors.length != 0) {
                // This ensures that, if the DING window isn't detected in three seconds
                // after launch, the desktop will be killed and, thus, relaunched again.
                this._waiting_for_windows = Main.layoutManager.monitors.length;
                this._launch_timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WINDOW_MAP_TIMEOUT_MS, () => {
                    this._launch_timer = 0;
                    this.subprocess.force_exit();
                    return false;
                });
            }
        }
        return this.subprocess;
    }

    cancel_timer() {
        if (this._launch_timer != 0) {
            GLib.source_remove(this._launch_timer);
            this._launch_timer = 0;
            this._waiting_for_windows = 0;
        }
    }

    set_cwd(cwd) {
        this._launcher.set_cwd(cwd);
    }

    read_output() {
        if (!this._dataInputStream) {
            return;
        }
        this._dataInputStream.read_line_async(GLib.PRIORITY_DEFAULT, this.cancellable, (object, res) => {
            try {
                const [output, length] = object.read_line_finish_utf8(res);
                if (length) {
                    print(`${this._process_id}: ${output}`);
                }
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    return;
                }
                console.error(e, `${this._process_id}_Error`);
            }

            this.read_output();
        });
    }

    /**
     * Queries whether the passed window belongs to the launched subprocess or not.
     *
     * @param {MetaWindow} window The window to check.
     */
    query_window_belongs_to(window) {
        if (!this.process_running) {
            return false;
        }
        try {
            let ownsWindow = this._waylandClient.owns_window(window);
            if (ownsWindow && (this._launch_timer != 0) && (this._waiting_for_windows != 0)) {
                console.log(`Received notification for window. ${this._waiting_for_windows - 1} notifications remaining.`);
                this._waiting_for_windows--;
                if (this._waiting_for_windows == 0) {
                    this.cancel_timer();
                }
            }
            return ownsWindow;
        } catch (error) {
            console.log(`Exception error: ${error.message}\n${error.stack}`);
            return false;
        }
    }
}
