# Privacy Policy — Game Report 帳密自動填入

**Last updated:** 2026-04-22

## What this extension does

This extension helps the user auto-fill login credentials on game operator
backend pages. It is designed to be used together with the **game-report**
internal tool, which is the single source of truth for the credentials
themselves.

## What data is handled

When the user clicks an "Open" button on the game-report accounts page,
that page sends a `postMessage` containing the target URL, username,
password, and optionally an extra login code.

The extension:

1. Receives the message from the page.
2. Writes the payload into `chrome.storage.session`, keyed by the target
   host. `chrome.storage.session` is volatile — it is cleared automatically
   when the browser is closed.
3. When the user navigates to the target host, the extension reads the
   payload back and fills it into the detected login form.
4. After filling, the payload is immediately deleted from
   `chrome.storage.session`.
5. If the payload is not consumed within 5 minutes, it expires and is
   deleted automatically.

## What data is NOT sent anywhere

- The extension does **not** transmit any data to any server controlled by
  the extension author or any third party.
- The extension does **not** contain analytics, telemetry, tracking, or
  remote-config code.
- The extension does **not** read credentials from the pages it runs on.
- The extension does **not** persist data to disk. All storage is in-memory
  (`chrome.storage.session`) and is lost on browser restart.

## Permissions

- `storage` — required for `chrome.storage.session` (in-memory, volatile).
- `host_permissions: <all_urls>` — required because the game operator
  backends the user logs into are not known in advance (operators may be
  added, changed, or replaced by the user at any time from the
  game-report UI). The extension only acts on a page after finding a
  matching entry in `chrome.storage.session`; it does not read or modify
  arbitrary pages otherwise.

## Contact

For questions about this privacy policy, please contact the maintainer of
the internal game-report tool.
