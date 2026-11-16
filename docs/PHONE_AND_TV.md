# Omnia on your iPhone and Android TV

Your PC stays the only place your data lives. Phones and TVs on the same Wi-Fi read it from
the desktop app's **LAN companion server**. Nothing goes through the internet, and only devices
you pair with a PIN get in.

```
 iPhone (Safari) ──┐                      ┌── SQLite, OTT sessions, player,
                   ├── Wi-Fi ── Omnia PC ─┤   importers, recommender
 Android TV app ───┘   :8765 HTTP          └── background delta sync
                       :8766 UDP (discovery)
```

## 1. Turn it on (PC)

1. In Omnia, open **Settings → Linked Devices** and switch on **Allow phones & TVs on this network**.
2. If Windows asks, allow Omnia on **private networks** (port 8765 TCP, 8766 UDP).
3. The panel shows a **6-digit PIN**, a **QR code**, the PC's address, and your paired devices with **Revoke**.

The PIN lasts 10 minutes, changes after every pairing, and is replaced after 5 wrong guesses.
Paired devices are remembered (only a hash of each device's token is stored) until you revoke them.

## 2. iPhone (Safari, no app needed)

Scan the QR code with the Camera app. It opens `http://<PC>:8765/pair?pin=…` and pairs at once.
You can also open `http://<PC address>:8765` in Safari and type the PIN.

- **Add to Home Screen** (Share → Add to Home Screen) gives you a full-screen icon.
- **Play** shows an *Open in Netflix / Prime Video / …* button. iOS opens the installed app
  through Universal Links (iOS only does that on a tap). What you watch there syncs back to the
  PC through its background delta sync.
- Account linking and history import stay on the PC: they need its player window.

### Phone as a remote

The **Remote** tab on the phone has a D-pad, OK, Back, Home and Play/Pause. Pick a screen at the
top: a TV running the Omnia app (listed while it's on), or the PC.

- **TV:** moves the focus around Omnia like the TV's own remote. Once a title opens in the
  Netflix / Prime app, use the TV remote: Android doesn't let one app drive another.
- **PC:** while Omnia's player is open, OK and Play/Pause pause or play, ◀ ▶ skip 10 s and Back
  returns to the hub. Otherwise the keys move a focus ring around the catalog.

Keys go from the phone to the PC (`POST /api/remote/send`). The TV picks up its keys with a
long-poll (`GET /api/remote/poll`), so nothing new has to be opened on the network.

To try TV-style navigation on any screen, turn on **Settings → Developer Options → TV navigation
on this device** (or add `?tv=1` to the address).

## 3. Android TV / Google TV / Fire TV (thin-client APK)

The TV app is a **thin client**: no database of its own. On start it looks for the PC
(UDP broadcast), asks for the PIN once (typed with the on-screen keyboard), then shows your
profiles, history and recommendations from the PC. If the PC is off you get
*Connecting to your PC…* until it answers. **Play** hands the title to the installed OTT app
with an Android intent (`nflx://www.netflix.com/watch/<id>` for Netflix, then the service's web
link as an App Link), so playback uses the real app with full DRM. Progress syncs back to the
PC through its background delta sync.

Navigation is D-pad only: arrows move focus, **OK** selects, **Back** closes the top layer
(keyboard, sheet, title page, then back to Home; at Home, Back leaves the app). You can try
the TV navigation on the desktop with `?tv=1` (and turn it off with `?tv=0`) in the dev server URL.

### Build the APK (one-time setup)

You need **Android Studio** (it installs the SDK), the **NDK** (in Android Studio: SDK
Manager → SDK Tools → *NDK (Side by side)*), and **JDK 17** (Android Studio bundles one).

```powershell
# PowerShell. Adjust the paths to your install.
$env:JAVA_HOME    = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME     = (Get-ChildItem "$env:ANDROID_HOME\ndk" | Sort-Object Name -Descending | Select-Object -First 1).FullName

rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

npm install
npm run tauri android init          # generates src-tauri/gen/android
```

### Make it a TV app (edit the generated project once)

In `src-tauri/gen/android/app/src/main/AndroidManifest.xml`:

```xml
<manifest ...>
    <!-- TVs have no touchscreen; leanback marks it as a TV app (still installs on phones). -->
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />
    <uses-feature android:name="android.software.leanback" android:required="false" />

    <application
        android:banner="@drawable/banner"
        android:usesCleartextTraffic="true"
        ... >
        <activity ...>
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
                <!-- Shows the app on the Google TV / Fire TV home screen. -->
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

- `usesCleartextTraffic="true"` is required: the PC is reached over plain HTTP on your LAN
  (`http://192.168.x.x:8765`). If the template sets it from a `${usesCleartextTraffic}`
  placeholder, set that placeholder to `"true"` for the release build type in
  `app/build.gradle.kts` (`manifestPlaceholders["usesCleartextTraffic"] = "true"`).
- Add a 320×180 PNG as `app/src/main/res/drawable/banner.png` (the TV home-screen tile).

### Build and install

```powershell
# Debug APK for a quick test (sideload with adb):
npm run tauri android build -- --debug --apk --target aarch64
adb connect <tv-ip>:5555                      # enable Developer options → Network debugging on the TV
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk

# Release APK (Fire TV sticks and most Google TVs are arm64; add armv7 for older sticks):
npm run tauri android build -- --apk --target aarch64 --target armv7
```

Release APKs must be signed before installing. Create a keystore once (`keytool -genkey -v
-keystore omnia.jks -keyalg RSA -keysize 2048 -validity 10000 -alias omnia`) and add a
`signingConfigs` block to `app/build.gradle.kts`, or sign the APK with `apksigner`.

`npm run tauri android build` automatically runs `npm run build:tv` (see
`src-tauri/tauri.android.conf.json`). That builds the frontend in thin-client mode
(`VITE_OMNIA_THIN_CLIENT=1`). On Android the Rust side compiles only `src-tauri/src/tv_client.rs`
(discovery and intents). The desktop backend (SQLite, ONNX, the player, axum) is desktop-only.

**Status:** the Android build has not been compiled or tested on a device yet, and the intent
URLs for apps other than Netflix are best guesses. Check the intents on your own TV.

## Security notes

- Unpaired devices only ever get the pairing page. Every API call needs a paired device's token
  (an `HttpOnly`, `SameSite=Lax` cookie for browsers, a bearer token for the TV app). Pairing again from an already-paired device replaces its old entry.
- Requests whose `Host` isn't an IP address, `localhost` or a `.local` name are refused (DNS
  rebinding), and so are cross-site requests, except from the TV app's own origin.
- Paired devices can browse, change their library and mark things watched, but they can't
  delete profiles, wipe history, link OTT accounts, open the PC's player or change LAN settings.
- Plain HTTP means someone on the same Wi-Fi could read the traffic in transit. Use it on a
  network you trust (your home Wi-Fi), not on public Wi-Fi.
