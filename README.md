# DDEV Projects GNOME Shell Extension

A GNOME Shell panel indicator for [DDEV](https://ddev.com/). It lists your DDEV projects, shows the status of each project's containers, and lets you start, stop and restart projects from the top bar.

## Features

- Panel icon with a counter of running projects.
- Status of the global DDEV services (`ddev-router`, `ddev-ssh-agent`).
- Project list with colored status indicators, running projects first:
  - green: running
  - yellow: paused / starting / unhealthy
  - red: stopped
- Expandable project details:
  - project status
  - clickable project URL (opens in the default browser)
  - per-container status (`web`, `db`, add-ons) with health info
- Context-aware actions:
  - stopped/paused project: **Start**
  - running project: **Stop**, **Restart**
- **Power off** (`ddev poweroff`).
- Live search by project name (focused automatically when the menu opens).
- Scrollable list for large numbers of projects.
- Desktop notifications when a command finishes or fails.
- Automatic refresh every 30 seconds and on every menu open.

## Requirements

- GNOME Shell 45–48 (tested on Ubuntu 24.04, GNOME 46)
- [DDEV](https://ddev.readthedocs.io/en/stable/users/install/) installed and available in `PATH`
- Docker, with your user in the `docker` group

## Installation

Clone the repository into the GNOME Shell extensions directory. The directory name must match the extension UUID:

```bash
git clone https://github.com/t1mm1/ddev-projects-manager.git \
  ~/.local/share/gnome-shell/extensions/ddev-projects-manager@pkasianov
```

Restart GNOME Shell:

- **X11:** press `Alt+F2`, type `r`, press `Enter`
- **Wayland:** log out and log back in

Enable the extension:

```bash
gnome-extensions enable ddev-projects-manager@pkasianov
```

## File structure

```bash
ddev-projects-manager@pkasianov/
├── extension.js
├── metadata.json
├── stylesheet.css
└── icons/
└── ddev-symbolic.svg
```

## Configuration

Settings are constants at the top of `extension.js`:

| Constant                  | Default | Description                              |
|---------------------------|---------|------------------------------------------|
| `REFRESH_SECONDS`         | `30`    | Background refresh interval (seconds)    |
| `SCROLL_MAX_SCREEN_RATIO` | `0.6`   | Max project list height (share of screen)|
| `COLORS`                  | -       | Status and link colors                   |

The panel icon is loaded from `icons/ddev-symbolic.svg`. Replace it with any monochrome SVG; the `-symbolic` suffix lets GNOME recolor it to match the theme. If the file is missing, a standard system icon is used.

Restart GNOME Shell after any change.

## How it works

The extension uses standard CLI tools, so it adds no dependencies and needs no background daemon:

- `ddev list -j` provides the projects and their status
- `docker ps -a --filter name=ddev-` provides the container states
- `ddev start|stop|restart <project>` and `ddev poweroff` run the actions

All commands run asynchronously and never block the Shell.

## Troubleshooting

View GNOME Shell logs:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Check the extension state:

```bash
gnome-extensions info ddev-projects-manager@pkasianov
```

If the menu shows `ddev not found in PATH` or `docker not found in PATH`, make sure the binaries are in one of: `/usr/bin`, `/usr/local/bin`, `~/.local/bin`, `/home/linuxbrew/.linuxbrew/bin`.

## License

MIT
