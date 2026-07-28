/* Gnome Shell Override
 *
 * Copyright (C) 2023 Sundeep Mediratta (smedius@gmail.com)
 * Copyright (C) 2024 Desktop Icons NG contributors
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

/* exported GnomeShellOverride */
'use strict';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import GObject from 'gi://GObject';

import {WorkspaceBackground} from 'resource:///org/gnome/shell/ui/workspace.js';
import {InjectionManager} from
    'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

export class GnomeShellOverride {
    constructor() {
        this._injectionManager = new InjectionManager();
    }

    enable() {
        this._injectionManager.overrideMethod(
            WorkspaceBackground.prototype, '_init',
            this._newBackgroundInit.bind(this));
    }

    disable() {
        this._injectionManager.clear();
    }

    _newBackgroundInit(origninalMethod) {
        return function (...args) {
            origninalMethod.call(this, ...args);

            /** @enum {number} */
            const ControlsState = {
                HIDDEN: 0,
                WINDOW_PICKER: 1,
                APP_GRID: 2,
            };

            const opaque = 255;
            const transparent = 0;

            const overviewAdjustment =
                Main.overview._overview._controls._stateAdjustment;

            function _windowIsOnThisMonitor(metawindow, monitorIndex) {
                const geometry =
                    global.display.get_monitor_geometry(monitorIndex);
                const [intersects] =
                    metawindow.get_frame_rect().intersect(geometry);
                return intersects;
            }

            const desktopWindows = global.get_window_actors().filter(a =>
                a.meta_window.get_window_type() === Meta.WindowType.DESKTOP &&
                _windowIsOnThisMonitor(a.meta_window, this._monitorIndex));

            if (desktopWindows.length) {
                const desktopLayer = new Clutter.Actor({
                    layout_manager: new DesktopLayout(),
                    clip_to_allocation: true,
                });

                for (let windowActor of desktopWindows) {
                    const clone = new Clutter.Clone({
                        source: windowActor,
                    });
                    desktopLayer.add_child(clone);

                    windowActor.connectObject('destroy', () => {
                        clone.destroy();
                    }, this);
                }

                const offset = 0;
                const syncAll = Clutter.BindConstraint.new(
                    this._bgManager.backgroundActor,
                    Clutter.BindCoordinate.ALL,
                    offset);
                desktopLayer.add_constraint(syncAll);

                overviewAdjustment.connectObject('notify::value',
                    () => {
                        const params =
                            overviewAdjustment.getStateTransitionParams();
                        const {initialState, finalState, progress,
                            transitioning} = params;

                        if (transitioning) {
                            if (finalState === ControlsState.HIDDEN)
                                desktopLayer.opacity =
                                    Util.lerp(transparent, opaque, progress);
                            else if (initialState === ControlsState.HIDDEN)
                                desktopLayer.opacity =
                                    Util.lerp(opaque, transparent, progress);
                            else
                                desktopLayer.opacity = transparent;
                        } else {
                            desktopLayer.opacity =
                                overviewAdjustment.value < 0.5
                                    ? opaque : transparent;
                        }
                    },
                    this
                );

                this._backgroundGroup.insert_child_above(
                    desktopLayer,
                    this._bgManager.backgroundActor
                );
            }
        };
    }
}

class DesktopLayout extends Clutter.LayoutManager {
    static {
        GObject.registerClass(this);
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const monitorIndex = Main.layoutManager.findIndexForActor(container);
        const monitor = Main.layoutManager.monitors[monitorIndex];
        const hscale = box.get_width() / monitor.width;
        const vscale = box.get_height() / monitor.height;

        for (const child of container) {
            const childBox = new Clutter.ActorBox();
            const frameRect = child.get_source()?.metaWindow.get_frame_rect();

            childBox.set_size(
                Math.round(frameRect.width * hscale),
                Math.round(frameRect.height * vscale)
            );

            childBox.set_origin(
                Math.round((frameRect.x - monitor.x) * hscale),
                Math.round((frameRect.y - monitor.y) * vscale)
            );

            child.allocate(childBox);
        }
    }
}
