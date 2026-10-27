# Remote Mac icon

`remote-mac-approved.png` is the original 1264 × 1264 Canva artwork approved by the user on 27 October 2026. Keep this source unchanged when regenerating platform assets.

[Original Canva image](https://www.canva.com/M/MAHZJLd0QNQ)

Design brief: a bold charcoal mouse cursor with two wireless signal arcs, on a soft lime background, matching the app's palette. No text or device illustration.

To regenerate on macOS with Python 3 and Pillow installed:

```sh
python3 scripts/generate-app-icons.py
```

The script creates an opaque 1024px phone icon, transparent Android adaptive and monochrome layers, a 64px favicon, and a macOS ICNS containing standard and Retina sizes. Android foreground artwork fits inside the [adaptive-icon safe zone](https://developer.android.com/develop/ui/views/launch/icon_design_adaptive). Expo references these files from `transmitter/app.config.ts`; the receiver package script copies the ICNS into the signed app bundle.

Phone launcher changes require a new native build and installation. Reloading JavaScript or Expo Go does not update the installed launcher icon. See [Expo's app icon guide](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/).
