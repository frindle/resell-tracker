"""Background OCR model updater: schedule helpers.

The updater runs inside the all-in-one container under supervisord. Once a day,
at local midnight (TZ from the environment, America/Los_Angeles by default) plus
a little jitter, it checks the upstream PaddleOCR models against the installed
version in the model store (see model_store.py). On boot it runs once right away
when the last check is too old, the same catch-up idea as the DB backup.

This file holds the pure time logic only. Both functions take `now` as an aware
datetime so they can be tested without touching the clock.
"""

from __future__ import annotations

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

CATCHUP_HOURS = 26


def next_run(now: datetime, tz: str, hour: int = 0, jitter_s: int = 0) -> datetime:
    """Next local `hour`:00 in zone `tz` strictly after `now`, plus `jitter_s` seconds.

    `now` is an aware datetime in any zone. The result is an aware datetime in
    `tz`. The local wall-clock target is rebuilt from a date each time, so DST
    changes never shift it off the hour.
    """
    raise NotImplementedError("model_update stub: next_run")


def catchup_due(status: dict, now: datetime, max_age_h: int = CATCHUP_HOURS) -> bool:
    """True when the boot catch-up run is due.

    Due when `status` has no usable `last_check` (missing, not a string, or not
    ISO-8601 with an offset) or when it is at least `max_age_h` hours before `now`.
    """
    raise NotImplementedError("model_update stub: catchup_due")
