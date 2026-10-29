# Gesture action lists

Open **Gesture controls**, expand a gesture, then choose **Add action**. Each gesture supports up to 20 actions. Use the arrows to change execution order, tap a step to edit it, or remove all steps to disable that gesture. Existing single-action settings remain compatible.

On the **Gestures** screen, tapping a card runs its saved action list when **Shake-to-Action** is on. When it is off, tapping a card opens **Gesture controls**, expands that gesture, and scrolls to its editor. The separate **Configure** button always opens settings at the top. This applies to directional and shake-count cards, including custom card order.

Card taps use the same action runner and completion rules as motion gestures. Android keeps ownership when a phone action backgrounds the app. Another card cannot start while a list is pending; a card with no saved actions shows a notice. Manual taps do not require a learned movement or a working motion sensor. If edited settings have not reached the native service yet, the tap reports that settings are updating instead of running an older list. Install Android **1.0.26** or later for manual card execution.

Available actions:

- **Mac action**: Screenshot, Kill current app, Lock/Unlock Mac, or Photo Booth.
- **Phone app**: choose a launchable app installed on the Android phone. Names and icons come from Android's launcher catalog; the saved value is the package ID.
- **Mac app**: choose an installed application from the paired Mac. The catalog is fetched through the existing authenticated Wi-Fi/Bluetooth connection. The saved value is the exact application bundle path, with a separate display name.
- **Mac command**: enter a shell command. The Mac receiver runs it using `/bin/zsh -lc` from the Mac user's home directory. The next step waits for exit. Commands time out after 20 seconds; output is discarded and command contents are not logged.
- **Open URL on Mac**: enter an HTTP or HTTPS link. The paired Mac opens YouTube media in the matching installed YouTube or YouTube Music app; other links use its default browser or registered URL handler.
- **Open URL on Phone**: enter an HTTP or HTTPS link. The phone hands it to its default browser or registered URL handler. This action works without a Mac connection.

App pickers search as you type, show icons, and support refreshing. Phone and Mac catalogs remain separate. The Mac picker requires a paired connection to the updated receiver; saved action lists can be edited offline.

URL fields keep the entered path, query, and fragment, trimming only surrounding whitespace. Use a full `http://` or `https://` address, up to 4,096 characters, without spaces or embedded sign-in details. Custom schemes, malformed URLs, and missing hosts cannot be saved. URL actions complete when the operating system accepts the request; they do not wait for the page to load.

## YouTube links on Mac

**Open URL on Mac** uses the same media routing as `testServer`'s `/open-url` and `/play` handlers. YouTube Music video/playlist links open in the installed **YouTube Music** Chrome web app. YouTube video/playlist, `youtu.be`, Shorts, Live, and Embed links open in the installed **YouTube** Chrome web app. HTTP media links are upgraded to HTTPS; video/playlist IDs and supported time/index parameters are preserved, with autoplay requested.

The receiver discovers the installed app and its registered Chrome profile instead of hardcoding app IDs. Chrome and the matching web app must already be installed. Missing apps, missing profiles, and invalid media links report a failed step; they do not silently fall back to a browser tab. YouTube home, search, and channel pages keep the normal URL handler. The receiver runs this routing itself; `testServer` does not need to be running.

Successful launch means playback was requested in the web app. YouTube can still require pressing Play, signing in, or choosing available media. The next gesture action waits for the launch request, not for playback to finish. Phone URL actions keep the phone's normal URL-handler behavior. Existing phone builds with URL actions already support this receiver update.

## Execution

A gesture snapshots its saved list, executes each step once in order, and blocks recognition of another gesture until the list finishes. Definite failures are reported and later steps continue. An uncertain Mac result pauses the list: reconnecting queries the original operation instead of resending it. Choosing **Resume gestures** abandons the unsent remainder. A process restart never replays unfinished lists.

During a directional action list, the Android home-screen widget and the in-app Shake-to-Action panel display only the activated gesture name across their full area: **Left**, **Right**, **Left → Straight**, or **Right → Straight**. The name stays visible between list steps. The existing display returns after completion or if the result becomes unknown, so recovery controls remain available. Shake-count gestures keep the normal display.

Android owns the complete list even if opening a phone app or URL sends Remote Mac to the background. Phone actions can work without a Mac connection; disconnected Mac steps report failure. Android [restricts activity launches from the background](https://developer.android.com/guide/components/activities/secure-bal), so a background phone-app or phone-URL action posts a notification to tap. That step is reported as requiring a tap rather than as an app or URL that was opened. Later steps continue without waiting for the tap, so deferred phone launches do not guarantee side-effect order with those later steps. Notification permission is needed for this fallback.

The Android app and Mac receiver both need rebuilding for this feature. iOS keeps foreground shake controls, Mac actions, and foreground phone-URL actions; installed-phone-app discovery is Android-only.

## Protocol

The receiver advertises `app_catalog`, `open_app`, `run_command`, and `open_url`. `apps_list` requests and `apps_list_result` responses use correlated IDs and byte-bounded pages. App, command, and Mac URL actions use the existing `system_action`, `system_action_result`, and status-query lifecycle, adding `appId`, `command`, or `url` parameters. URL list steps are stored as `{type: "open_url", target: "mobile" | "server", url}`. URL contents are omitted from receiver command logs. Reusing an operation ID with different parameters is rejected. Existing built-in action identities, including `lock`, are unchanged.
