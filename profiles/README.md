# Profiles

`synesthesia.json` is the default user-owned pitch and response profile bundled
into the visualizer. Runtime calibration changes are stored in the WebView/browser
local profile so this source default remains recoverable through Reset.

Calibration now offers local profile export/import and backup restore. Reset,
import, and restore require confirmation; failure leaves prior saved bytes
recoverable. Unreadable settings are not silently deleted. Keep exports private:
the bundled default can itself contain personal pitch colors.

See [profile migration and recovery](../docs/profile-migration.md) before moving
to a hosted origin. The real desktop transfer remains unverified while the app
is kept closed. Do not replace this default or publish it as a public template
until the user's actual profile has been exported and compared successfully.
