// DDEV Projects GNOME Shell extension
// Lists DDEV projects, their containers and provides start/stop/restart actions.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const REFRESH_SECONDS = 30;
const SCROLL_MAX_SCREEN_RATIO = 0.6;
const ALL = '*';
const GLOBAL_CONTAINERS = ['ddev-router', 'ddev-ssh-agent'];
const SERVICE_ORDER = ['web', 'db'];
const UP_STATUSES = ['running', 'starting', 'unhealthy'];

const COLORS = {
    ok: '#27ae60',
    warn: '#e6b800',
    err: '#e74c3c',
    link: '#3584e4',
};

const DOCKER_FORMAT = [
    '{{.Names}}',
    '{{.Label "com.ddev.site-name"}}',
    '{{.Label "com.docker.compose.project"}}',
    '{{.Label "com.docker.compose.service"}}',
    '{{.State}}',
    '{{.Status}}',
].join('|');

/**
 * @typedef {object} Container
 * @property {string} name - Container name.
 * @property {string} site - DDEV site name label.
 * @property {string} project - Docker Compose project label.
 * @property {string} service - Docker Compose service label.
 * @property {string} state - Docker state (running, exited, ...).
 * @property {string} status - Human-readable Docker status.
 */

/**
 * Resolves an executable path, falling back to common locations
 * missing from GNOME Shell's PATH.
 *
 * @param {string} name - Binary name.
 * @returns {string|null} Absolute path or null if not found.
 */
function findProgram(name) {
    const found = GLib.find_program_in_path(name);
    if (found)
        return found;
    const home = GLib.get_home_dir();
    const candidates = [
        `/usr/local/bin/${name}`,
        `/usr/bin/${name}`,
        `${home}/.local/bin/${name}`,
        `/home/linuxbrew/.linuxbrew/bin/${name}`,
    ];
    return candidates.find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

/**
 * Runs a command asynchronously and collects its output. Never rejects.
 *
 * @param {string[]} argv - Command and arguments.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>} Execution result.
 */
function run(argv) {
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(res);
                    resolve({ok: p.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''});
                } catch (e) {
                    resolve({ok: false, stdout: '', stderr: String(e)});
                }
            });
        } catch (e) {
            resolve({ok: false, stdout: '', stderr: String(e)});
        }
    });
}

/**
 * Extracts the project list from `ddev list -j` output.
 *
 * @param {string} stdout - Raw command output (JSON log lines).
 * @returns {object[]} Projects from the "raw" field, or an empty array.
 */
function parseDdevList(stdout) {
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{'))
            continue;
        try {
            const obj = JSON.parse(trimmed);
            if (Array.isArray(obj.raw))
                return obj.raw;
        } catch (_e) {
            // Ignore non-JSON or unrelated lines.
        }
    }
    return [];
}

/**
 * Parses `docker ps` output formatted with DOCKER_FORMAT.
 *
 * @param {string} stdout - Raw command output.
 * @returns {Container[]} Parsed containers.
 */
function parseContainers(stdout) {
    return stdout
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => {
            const [name, site, project, service, state, ...rest] = l.split('|');
            return {name, site, project, service, state, status: rest.join('|')};
        });
}

/**
 * Builds the Docker Compose project name DDEV uses for a site.
 *
 * @param {string} siteName - DDEV project name.
 * @returns {string} Compose project name.
 */
function composeProjectName(siteName) {
    return `ddev-${siteName.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
}

/**
 * Checks whether a container belongs to a DDEV project.
 *
 * @param {Container} container - Container to check.
 * @param {string} siteName - DDEV project name.
 * @returns {boolean} True if the container is part of the project.
 */
function belongsTo(container, siteName) {
    return container.site === siteName || container.project === composeProjectName(siteName);
}

/**
 * Checks whether a project status means its containers are up.
 *
 * @param {string} status - DDEV project status.
 * @returns {boolean} True for running, starting or unhealthy.
 */
function isUp(status) {
    return UP_STATUSES.includes(status);
}

/**
 * Capitalizes a status for display.
 *
 * @param {string} status - Raw status.
 * @returns {string} Display title.
 */
function statusTitle(status) {
    const s = String(status ?? '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown';
}

/**
 * Maps a project status to a color: running = green,
 * paused/transitional = yellow, stopped/other = red.
 *
 * @param {string} status - DDEV project status.
 * @returns {string} Hex color.
 */
function projectColor(status) {
    if (status === 'running')
        return COLORS.ok;
    if (status === 'paused' || status === 'starting' || status === 'unhealthy')
        return COLORS.warn;
    return COLORS.err;
}

/**
 * Maps a container state to a color: running = green,
 * degraded/transitional = yellow, exited/dead = red.
 *
 * @param {Container} c - Container.
 * @returns {string} Hex color.
 */
function containerColor(c) {
    if (c.state === 'running')
        return c.status.includes('unhealthy') ? COLORS.warn : COLORS.ok;
    if (c.state === 'exited' || c.state === 'dead')
        return COLORS.err;
    return COLORS.warn;
}

/**
 * Sorts containers: services from SERVICE_ORDER first, then alphabetically.
 *
 * @param {Container[]} list - Containers to sort.
 * @returns {Container[]} New sorted array.
 */
function sortContainers(list) {
    const rank = s => {
        const i = SERVICE_ORDER.indexOf(s);
        return i === -1 ? SERVICE_ORDER.length : i;
    };
    return [...list].sort((a, b) =>
        rank(a.service) - rank(b.service) || (a.service || a.name).localeCompare(b.service || b.name));
}

/**
 * Returns the trimmed end of a text, limited in length.
 *
 * @param {string} text - Source text.
 * @param {number} [max=200] - Maximum length.
 * @returns {string} Truncated text.
 */
function tail(text, max = 200) {
    const t = text.trim();
    return t.length > max ? `…${t.slice(-max)}` : t;
}

/**
 * Creates a label with an optional inline color.
 * Inline style is used because Pango markup colors get reset by the theme.
 *
 * @param {string} text - Label text.
 * @param {string|null} [color=null] - CSS color.
 * @param {string} [styleClass=''] - CSS class.
 * @returns {St.Label} Label actor.
 */
function makeLabel(text, color = null, styleClass = '') {
    return new St.Label({
        text: String(text ?? ''),
        style: color ? `color: ${color};` : '',
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

/**
 * Panel indicator with the DDEV projects menu.
 */
const DdevIndicator = GObject.registerClass(
    class DdevIndicator extends PanelMenu.Button {
        /**
         * Sets up the panel button, menu layout and refresh timer.
         *
         * @param {string} extensionPath - Extension directory, used to load the icon.
         */
        _init(extensionPath) {
            super._init(0.0, 'DDEV Projects', false);

            this._ddev = findProgram('ddev');
            this._docker = findProgram('docker');
            this._projects = [];
            this._containers = [];
            this._projectItems = [];
            this._noMatchItem = null;
            this._busy = new Set();
            this._error = null;
            this._loaded = false;
            this._signature = null;
            this._refreshing = false;
            this._pendingRefresh = false;
            this._destroyed = false;
            this._focusId = 0;

            // Panel button: icon + running projects counter.
            const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
            box.add_child(new St.Icon({
                gicon: this._loadPanelIcon(extensionPath),
                style_class: 'system-status-icon',
            }));
            this._countLabel = new St.Label({
                text: '',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'ddev-count',
            });
            box.add_child(this._countLabel);
            this.add_child(box);

            this._buildLayout();

            this.menu.connect('open-state-changed', (_menu, open) => {
                if (open) {
                    this._updateScrollHeight();
                    this._rebuild();
                    this._refresh();
                    this._focusSearch();
                } else {
                    this._searchEntry.set_text('');
                }
            });

            this._rebuild();
            this._refresh();

            // Background refresh only while the menu is closed,
            // so an expanded project is not collapsed by a rebuild.
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                if (!this.menu.isOpen)
                    this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
        }

        /**
         * Loads the panel icon from the extension directory or falls back to a themed icon.
         *
         * @param {string} extensionPath - Extension directory.
         * @returns {Gio.Icon} Icon to display.
         */
        _loadPanelIcon(extensionPath) {
            const file = Gio.File.new_for_path(
                GLib.build_filenamev([extensionPath, 'icons', 'ddev-symbolic.svg']));
            if (file.query_exists(null))
                return new Gio.FileIcon({file});
            return new Gio.ThemedIcon({name: 'network-server-symbolic'});
        }

        /**
         * Creates persistent menu sections: global services, search,
         * scrollable project list and global actions.
         */
        _buildLayout() {
            this._topSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._topSection);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Live search field.
            this._searchSection = new PopupMenu.PopupMenuSection();
            const searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            this._searchEntry = new St.Entry({
                style_class: 'search-entry ddev-search',
                hint_text: 'Search projects…',
                can_focus: true,
                track_hover: true,
                x_expand: true,
            });
            this._searchEntry.set_primary_icon(new St.Icon({
                icon_name: 'edit-find-symbolic',
                style_class: 'popup-menu-icon',
            }));
            this._searchEntry.clutter_text.connect('text-changed', () => this._applyFilter());
            searchItem.add_child(this._searchEntry);
            this._searchSection.addMenuItem(searchItem);
            this.menu.addMenuItem(this._searchSection);

            // Projects section inside a scroll view (keeps menu signal wiring).
            this._projectsSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._projectsSection);
            this.menu.box.remove_child(this._projectsSection.actor);
            this._scroll = new St.ScrollView({
                style_class: 'ddev-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: false,
            });
            this._scroll.set_child(this._projectsSection.actor);
            this.menu.box.add_child(this._scroll);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._bottomSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._bottomSection);
        }

        /**
         * Moves keyboard focus to the search field once the menu is shown.
         */
        _focusSearch() {
            if (this._focusId)
                GLib.source_remove(this._focusId);
            this._focusId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._focusId = 0;
                if (this.menu.isOpen)
                    this._searchEntry.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        }

        /**
         * Shows only projects matching the search query (case-insensitive substring).
         */
        _applyFilter() {
            const query = this._searchEntry.get_text().trim().toLowerCase();
            let visible = 0;
            for (const {name, item} of this._projectItems) {
                const match = !query || name.toLowerCase().includes(query);
                item.visible = match;
                if (match)
                    visible++;
            }
            if (this._noMatchItem)
                this._noMatchItem.visible = this._projectItems.length > 0 && visible === 0;
        }

        /**
         * Limits the project list height relative to the primary monitor work area.
         */
        _updateScrollHeight() {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const maxHeight = Math.floor((workArea.height * SCROLL_MAX_SCREEN_RATIO) / scale);
            this._scroll.style = `max-height: ${maxHeight}px;`;
        }

        /**
         * Fetches projects and containers, then rebuilds the menu if data changed.
         * Concurrent calls are coalesced into one follow-up refresh.
         *
         * @returns {Promise<void>}
         */
        async _refresh() {
            if (this._destroyed)
                return;
            if (this._refreshing) {
                this._pendingRefresh = true;
                return;
            }
            if (!this._ddev || !this._docker) {
                this._rebuild();
                return;
            }

            this._refreshing = true;
            try {
                const [list, ps] = await Promise.all([
                    run([this._ddev, 'list', '-j']),
                    run([this._docker, 'ps', '-a', '--filter', 'name=ddev-', '--format', DOCKER_FORMAT]),
                ]);
                if (this._destroyed)
                    return;

                this._projects = parseDdevList(list.stdout).sort((a, b) =>
                    Number(isUp(b.status)) - Number(isUp(a.status)) || a.name.localeCompare(b.name));
                this._containers = parseContainers(ps.stdout);
                this._error = list.ok ? null : tail(list.stderr || 'ddev list failed');
                this._loaded = true;

                this._updatePanel();

                const signature = JSON.stringify([
                    this._projects.map(p => [p.name, p.status]),
                    this._containers,
                    [...this._busy],
                    this._error,
                ]);
                if (signature !== this._signature) {
                    this._signature = signature;
                    this._rebuild();
                }
            } finally {
                this._refreshing = false;
                if (this._pendingRefresh && !this._destroyed) {
                    this._pendingRefresh = false;
                    this._refresh();
                }
            }
        }

        /**
         * Updates the running projects counter in the panel.
         */
        _updatePanel() {
            const running = this._projects.filter(p => p.status === 'running').length;
            this._countLabel.text = running > 0 ? String(running) : '';
        }

        /**
         * Checks whether a command is running for a project or for all projects.
         *
         * @param {string} name - Project name.
         * @returns {boolean} True if the project is busy.
         */
        _isBusy(name) {
            return this._busy.has(name) || this._busy.has(ALL);
        }

        /**
         * Adds a non-clickable row composed of labels.
         *
         * @param {PopupMenu.PopupMenuBase} menu - Target menu or section.
         * @param {St.Label[]} labels - Row content.
         * @returns {PopupMenu.PopupBaseMenuItem} Created row.
         */
        _addRow(menu, labels) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const box = new St.BoxLayout({style_class: 'ddev-row', x_expand: true});
            for (const label of labels)
                box.add_child(label);
            item.add_child(box);
            menu.addMenuItem(item);
            return item;
        }

        /**
         * Adds a status row: colored dot, title and optional colored detail.
         *
         * @param {PopupMenu.PopupMenuBase} menu - Target menu or section.
         * @param {string} title - Row title.
         * @param {string} detail - Status text; omitted if empty.
         * @param {string} color - Dot and detail color.
         * @returns {PopupMenu.PopupBaseMenuItem} Created row.
         */
        _addStatusRow(menu, title, detail, color) {
            const labels = [makeLabel('●', color, 'ddev-dot'), makeLabel(title)];
            if (detail)
                labels.push(makeLabel(detail, color));
            return this._addRow(menu, labels);
        }

        /**
         * Adds a clickable menu item with an icon.
         *
         * @param {PopupMenu.PopupMenuBase} menu - Target menu or section.
         * @param {string} label - Item text.
         * @param {string} iconName - Themed icon name.
         * @param {Function} callback - Called on activation.
         * @returns {PopupMenu.PopupImageMenuItem} Created item.
         */
        _addAction(menu, label, iconName, callback) {
            const item = new PopupMenu.PopupImageMenuItem(label, iconName);
            item.connect('activate', () => callback());
            menu.addMenuItem(item);
            return item;
        }

        /**
         * Shows a pointing-hand cursor while the item is hovered.
         *
         * @param {PopupMenu.PopupBaseMenuItem} item - Clickable menu item.
         */
        _setPointerCursor(item) {
            const reset = () => global.display.set_cursor(Meta.Cursor.DEFAULT);
            item.connect('notify::hover', () => {
                global.display.set_cursor(item.hover ? Meta.Cursor.POINTING_HAND : Meta.Cursor.DEFAULT);
            });
            item.connect('activate', reset);
            item.connect('destroy', reset);
        }

        /**
         * Rebuilds all dynamic menu content from the current state.
         */
        _rebuild() {
            this._topSection.removeAll();
            this._projectsSection.removeAll();
            this._bottomSection.removeAll();
            this._projectItems = [];
            this._noMatchItem = null;

            if (!this._ddev || !this._docker) {
                this._addRow(this._topSection, [makeLabel(`${this._ddev ? 'docker' : 'ddev'} not found in PATH`, COLORS.err)]);
                return;
            }
            if (!this._loaded) {
                this._addRow(this._topSection, [makeLabel('Loading…')]);
                return;
            }
            if (this._error)
                this._addRow(this._topSection, [makeLabel(this._error, COLORS.err)]);

            // Global DDEV services (router, ssh-agent).
            for (const name of GLOBAL_CONTAINERS) {
                const c = this._containers.find(x => x.name === name);
                const label = name.replace('ddev-', '');
                if (c)
                    this._addStatusRow(this._topSection, label, c.status, containerColor(c));
                else
                    this._addStatusRow(this._topSection, label, 'not running', COLORS.err);
            }

            if (!this._projects.length)
                this._addRow(this._projectsSection, [makeLabel('No DDEV projects')]);

            for (const project of this._projects) {
                const item = this._buildProjectItem(project);
                this._projectsSection.addMenuItem(item);
                this._projectItems.push({name: project.name, item});
            }

            this._noMatchItem = this._addRow(this._projectsSection, [makeLabel('No matches')]);
            this._noMatchItem.visible = false;
            this._applyFilter();

            const poweroff = this._addAction(
                this._bottomSection,
                'Power off all',
                'system-shutdown-symbolic',
                () => this._runAction(ALL, ['poweroff'], 'All projects powered off')
            );
            poweroff.setSensitive(!this._busy.has(ALL));
        }

        /**
         * Builds an expandable project item with status, URL, containers and actions.
         *
         * @param {object} p - Project from `ddev list -j`.
         * @returns {PopupMenu.PopupSubMenuMenuItem} Project item.
         */
        _buildProjectItem(p) {
            const busy = this._isBusy(p.name);
            const up = isUp(p.status);
            const color = busy ? COLORS.warn : projectColor(p.status);

            // Header: colored dot, project name (default color), colored status.
            const item = new PopupMenu.PopupSubMenuMenuItem(p.name, false);
            item.menu.actor.add_style_class_name('ddev-submenu');
            item.insert_child_below(makeLabel('●', color, 'ddev-dot'), item.label);
            item.insert_child_above(makeLabel(busy ? 'working…' : p.status, color, 'ddev-status'), item.label);

            const menu = item.menu;

            if (busy) {
                this._addRow(menu, [makeLabel('Command in progress…', COLORS.warn)]);
                return item;
            }

            this._addStatusRow(menu, statusTitle(p.status), '', color);

            if (up) {
                if (p.primary_url) {
                    const link = new PopupMenu.PopupImageMenuItem(p.primary_url, 'web-browser-symbolic');
                    link.label.style = `color: ${COLORS.link};`;
                    link.connect('activate', () => this._openUri(p.primary_url));
                    this._setPointerCursor(link);
                    menu.addMenuItem(link);
                }

                const containers = sortContainers(this._containers.filter(c => belongsTo(c, p.name)));
                for (const c of containers)
                    this._addStatusRow(menu, c.service || c.name, c.status, containerColor(c));

                this._addAction(menu, 'Stop', 'media-playback-stop-symbolic',
                    () => this._runAction(p.name, ['stop', p.name], 'Stopped'));
                this._addAction(menu, 'Restart', 'view-refresh-symbolic',
                    () => this._runAction(p.name, ['restart', p.name], 'Restarted'));
            } else {
                this._addAction(menu, 'Start', 'media-playback-start-symbolic',
                    () => this._runAction(p.name, ['start', p.name], 'Started'));
            }

            return item;
        }

        /**
         * Runs a ddev command, marks the target as busy and notifies on completion.
         *
         * @param {string} key - Project name or ALL.
         * @param {string[]} args - ddev arguments.
         * @param {string} doneText - Notification text on success.
         * @returns {Promise<void>}
         */
        async _runAction(key, args, doneText) {
            this._busy.add(key);
            this._signature = null;
            this._rebuild();

            const res = await run([this._ddev, ...args]);
            if (this._destroyed)
                return;

            this._busy.delete(key);
            const title = key === ALL ? 'DDEV' : `DDEV: ${key}`;
            if (res.ok)
                Main.notify(title, doneText);
            else
                Main.notify(title, `Failed: ${tail(res.stderr || res.stdout)}`);

            this._signature = null;
            this._refresh();
        }

        /**
         * Opens a URI with the default application.
         *
         * @param {string} uri - URL or file URI.
         */
        _openUri(uri) {
            try {
                Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
            } catch (_e) {
                Main.notify('DDEV', `Cannot open ${uri}`);
            }
        }

        /**
         * Stops timers and pending idle callbacks before destruction.
         */
        _onDestroy() {
            this._destroyed = true;
            if (this._timerId) {
                GLib.source_remove(this._timerId);
                this._timerId = 0;
            }
            if (this._focusId) {
                GLib.source_remove(this._focusId);
                this._focusId = 0;
            }
            super._onDestroy();
        }
    });

/**
 * Extension entry point.
 */
export default class DdevProjectsExtension extends Extension {
    /**
     * Adds the indicator to the top panel.
     */
    enable() {
        this._indicator = new DdevIndicator(this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    /**
     * Removes the indicator and releases resources.
     */
    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}