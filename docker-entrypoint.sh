#!/bin/sh

# Runs the app as the unprivileged `node` user (uid 1000) instead of root.
#
# The container starts as root only for one thing: the data folder can hold
# files root wrote — an image from before the app dropped root, or a restore
# done as root — that `node` couldn't open. Those are handed to `node` here,
# then the app starts as `node`. Started as a non-root user already (e.g.
# `user: "1000:1000"` in compose), it runs the command as is.
set -eu

if [ "$(id -u)" = 0 ]; then
  data="${DATA_DIR:-/app/data}"
  mkdir -p "$data"
  # Work on the resolved folder, so a symlinked data folder is handed over too.
  real=$(readlink -f "$data")
  # Never hand over system folders, whatever DATA_DIR says: that would give
  # node files that run as root on the next start.
  case "$real" in
    / | /app | /bin | /bin/* | /dev | /dev/* | /etc | /etc/* | /lib | /lib/* | \
    /proc | /proc/* | /root | /root/* | /sbin | /sbin/* | /sys | /sys/* | \
    /usr | /usr/* | /var)
      echo "skin-hq: DATA_DIR=$data is a system folder; not giving it to the node user." >&2
      exec su-exec node "$@"
      ;;
  esac
  # Only what isn't node's yet, so a normal start touches nothing. Symlinks are
  # skipped and never followed (-h), and the walk stays on this filesystem
  # (-xdev), so nothing outside the folder can change hands.
  if ! find "$real" -xdev ! -type l \( ! -user node -o ! -group node \) \
    -exec chown -h node:node {} +; then
    echo "skin-hq: could not give $data to the node user (uid 1000)." >&2
    echo "skin-hq: if the app then can't write its database, give that folder to uid 1000 on the host." >&2
  fi
  exec su-exec node "$@"
fi

exec "$@"
