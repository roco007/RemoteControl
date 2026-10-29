# Learning motion gestures from five examples

The Android calibration flow collects five takes of each selected movement. The user can train one movement or all seven, pause between takes, and save only when the selected set is complete. Existing actions, card order, pairing, enabled state, and previous calibration remain intact until Save succeeds.

## Recording and progress

- One movement requires five takes; all seven require thirty-five.
- The screen shows the current movement, Take 1–5, and total recorded examples. Record remains an explicit user action.
- Every completed recording that receives sensor data is kept. Calibration does not judge its direction, angle, posture, shake count, return position, strength, or resemblance to the other takes. A still recording is also kept. Only an unavailable sensor or a recording with no usable sensor data requires retrying.
- The selected gesture is an action label. The user teaches the motion associated with that label; the illustrated flick, tilt, and shake examples are optional. A unique take is retained and can match on its own.
- Leaving the app pauses the session and retains completed takes while its native process remains alive. Cancel leaves the previously saved profile unchanged. Save failures retain the action guard and restore previous persisted data.

## Optional easy movements

Hold the phone comfortably and choose a different motion for each shortcut:

- Tilt left, then return upright.
- Tilt right, then return upright.
- Move the upright phone a short distance up, then return.
- Move the upright phone a short distance down, then return.

Keep the screen facing you: X is left/right, Y is up/down, and depth Z is ignored. These are phone-relative axes, not reconstructed position coordinates. Repeat the chosen motion five times at a comfortable pace. Start with one or two shortcuts if preferred. These suggestions are not acceptance rules; every usable recording is still kept as performed. Existing gesture labels and action assignments stay unchanged.

## Inspecting takes before choosing rules

The calibration screen can display completed draft takes and saved training. Choose a gesture label and a take, then inspect the X/Y graph, measurements, and numeric samples. New recordings retain their original accelerometer readings alongside the learned templates when Save succeeds. Draft readings are temporary until then. Sharing readings is an explicit user action.

Raw X/Y values displayed in the viewer are in g and include gravity. Original XYZ samples are preserved in storage and JSON exports for diagnostics; Z does not contribute to recognition. Time starts at the first accepted sensor frame; the first 1.2 seconds are preparation. The graph's full capture duration therefore differs from the trimmed movement duration used by the recognizer. The matching view uses the same effective XY template as the recognizer: a dimensionless 32-point shape after baseline removal and amplitude scaling using X/Y only. Its horizontal axis is sample position, not the original sensor timestamp. Older training can show these saved shapes, but it cannot supply raw readings that were never retained.

Readings are evidence for selecting rules, not a new automatic formula. Compare the sign and range of each axis, movement duration, and return toward the starting posture across the user's takes. Then check candidate rules against held-out repetitions, other gesture labels, and ordinary handling. Five examples alone cannot establish a reliable false-trigger rate. The viewer leaves the existing matcher and action-completion guard unchanged.

## Recognition

New version-3 models use generic signed, baseline-relative X/Y accelerometer sequences. Each selected label retains all five bounded templates, with 32 two-axis samples per template and movement-duration/amplitude metadata. The existing serialized vector shape keeps a zero Z component. Depth is excluded before activity detection, trimming, baseline removal, amplitude scaling, matching, and quiet-time calculation. Changing only Z therefore cannot start or finish a gesture, change its match, or extend the settling wait. Legacy directional and shake recognition, and the JavaScript shake fallback, use the same X/Y restriction. Constrained dynamic time warping compares the actual motion shapes with timing variation. A sufficiently close match to **any one** saved example can trigger its label's action; agreement with another example is not required. The closest matching example across active labels wins, with stable gesture order resolving exact ties. Movement that resembles no saved example produces no learned action.

This template approach is informed by the primary [uWave accelerometer recognition paper](https://www.yecl.org/publications/liu09percom.pdf). This implementation uses its own preprocessing, rejection rules, and continuous-stream handling; the paper's accuracy results do not establish this app's accuracy.

Live motion is compared with the recorded shapes without imposing a flick, tilt, or shake definition. Partial returns and sequences of movements in the phone's X/Y plane can be taught. Motions distinguished only by depth become indistinguishable; choose different X/Y patterns for those labels. Generic activity detection prevents a stationary phone from repeatedly triggering a still template. Sampling gaps, reset, disconnection, calibration entry/exit, and cooldown discard pending motion without dispatch.

Learned directional movements can be evaluated after 320 milliseconds of settling. Rest detection accounts for ordinary hand tremor. Before dispatch, runtime continuation checks compare the observed movement with unfinished portions of the saved takes, using original readings when available to preserve short movements that compressed templates can lose. A plausible continuation keeps its own pause allowance; an unrelated long example no longer imposes that wait on every movement. Long generic templates without original readings retain the previous silence policy for the active mode. Count sequences and legacy recognition keep their existing timing.

The action guard still stops motion input until the matching Mac operation completes. The faster directional path then observes one second of fresh rest before accepting another movement, preventing the tail of the first gesture from becoming a second action. It resumes sensor observation immediately after completion instead of stacking the previous fixed 700-millisecond pause on top of this rest check. This rearm period affects readiness for the next gesture, not completion of the current action. Full-example match scores, thresholds, saved templates, and original readings remain unchanged; continuation metadata exists only in memory.

A learned movement uses the template decision, without falling back to its older threshold recognizer after a mismatch. Untrained movements keep their previous recognizers, now restricted to X/Y. Mixed learned/legacy recognition produces at most one command for a movement.

## Persistence and compatibility

Learned models extend the existing native calibration profile. Older profiles load without templates and keep their saved tuning. Version-1 and version-2 learned models remain readable; saving new takes for a label replaces it with a version-3 model. Existing ten-example models remain readable and keep every saved example. New version-3 models contain five examples. Runtime and the readings viewer adapt old models through one shared conversion: where original raw takes exist, it rebuilds templates from their X/Y readings with the existing preparation policy; otherwise it projects and rescales the saved shapes. Model-only conversion cannot recover timing detail already discarded by older preprocessing. Adaptation does not overwrite the original stored models or raw takes, and does not change the existing full-match threshold. Version-1 models retain their older two-example and ambiguity rules. Training one movement replaces only that label and preserves other models and legacy values, including profiles mixing five- and ten-example labels. Status reports learned coverage separately from older calibration coverage so the UI can explain which movements have saved training.

Templates and original readings stay on the phone. Their JSON representation has explicit gesture, take-count, sample-count, numeric, and size bounds; the persistence envelope is limited to 2 MiB. Compact raw arrays retain the original numeric precision, with relative sensor times, and are committed in the same transaction as the learned profile. Training selected labels replaces only their raw takes and models. Failed writes restore the previous record. Neither recordings nor models are sent to the Mac; the user can explicitly share a movement's readings from the viewer.

## Verification boundaries

Tests cover five/thirty-five-take progression, partial progress, interruption, cancellation, save rollback, legacy parsing, all-model round trips, and malformed/oversized storage. New model tests cover accepting still and unconventional takes, matching a unique example among other different examples, label-independent recognition, timing variation, idle behavior, and mixed legacy/template operation. XY regressions compare identical X/Y with different Z sequences and require identical templates, classifications, and dispatch times; pure depth movement must not dispatch. Compatibility checks preserve unselected raw takes when another label is retrained. Matching a stored take to itself is insufficient evidence for recognition accuracy.

The release APK must be checked against the current sources and installed over the existing USB-connected app. Device checks verify recording progress and saved-state preservation. Temporary test takes are canceled and never saved as the user's personal training. The user's five real takes and subsequent foreground/background shortcut delivery remain physical acceptance steps.
