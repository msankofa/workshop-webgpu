import datetime
import json
import os
import threading


LOG_FORMAT = 'pcw-base-game-performance-log'
LOG_VERSION = 1
ENTRY_FORMAT = 'pcw-base-game-performance-capture'
ENTRY_VERSION = 1
_WRITE_LOCK = threading.Lock()


def _validate_entry(entry):
    if not isinstance(entry, dict):
        raise ValueError('performance capture must be an object')
    if entry.get('format') != ENTRY_FORMAT or entry.get('version') != ENTRY_VERSION:
        raise ValueError('unsupported performance capture format')
    label = entry.get('label')
    if label is not None and (not isinstance(label, str) or not label.strip() or len(label) > 120):
        raise ValueError('performance capture label must contain 1-120 characters when provided')
    if not isinstance(entry.get('settingsAtStart'), dict):
        raise ValueError('performance capture settingsAtStart must be an object')
    if not isinstance(entry.get('performance'), dict):
        raise ValueError('performance capture performance must be an object')


def prepend_performance_capture(target_path, entry):
    _validate_entry(entry)
    with _WRITE_LOCK:
        document = {
            'format': LOG_FORMAT,
            'version': LOG_VERSION,
            'updatedAt': None,
            'entries': [],
        }
        try:
            with open(target_path, 'r', encoding='utf-8') as handle:
                existing = json.load(handle)
            if not isinstance(existing, dict) or existing.get('format') != LOG_FORMAT \
                    or existing.get('version') != LOG_VERSION or not isinstance(existing.get('entries'), list):
                raise ValueError('existing performance log has an unsupported format')
            document = existing
        except FileNotFoundError:
            pass

        document['entries'].insert(0, entry)
        document['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
        os.makedirs(os.path.dirname(os.path.abspath(target_path)), exist_ok=True)
        temporary = f'{target_path}.tmp'
        with open(temporary, 'w', encoding='utf-8', newline='\n') as handle:
            json.dump(document, handle, indent=2, ensure_ascii=False)
            handle.write('\n')
        os.replace(temporary, target_path)
        return len(document['entries'])
