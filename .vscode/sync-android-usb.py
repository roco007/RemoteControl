#!/usr/bin/env python3
"""Build current Remote Mac sources and update one USB Android phone without clearing data.

Run from any directory. Use --check for preflight or --build-only to make an APK.
Requires Python 3.9+, Node 22.13+, npm dependencies, EAS CLI/login, JDK 17, and Android SDK.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from datetime import datetime
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'dist' / 'android-usb-sync'


class SyncError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise SyncError(message)


def capture(args, *, env=None, cwd=ROOT):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        # Do not echo command arguments or raw EAS output, which may contain secrets.
        raise SyncError(f'{Path(args[0]).name} failed (exit {result.returncode}).')
    return result.stdout


def version_tuple(value):
    return tuple(int(part) for part in re.findall(r'\d+', value)[:3])


def tools_environment():
    env = dict(os.environ)
    for name in ['MAC_UNLOCK_TEXT', 'EXPO_DEBUG', 'DEBUG', 'EAS_LOCAL_BUILD_PLUGIN_INPUT']:
        env.pop(name, None)
    home = Path.home()
    nvm = Path(env.get('NVM_DIR', home / '.nvm'))
    candidates = [env.get('NODE_BINARY'), shutil.which('node')]
    candidates += sorted(nvm.glob('versions/node/*/bin/node'), key=lambda p: version_tuple(p.parent.parent.name), reverse=True)
    node = None
    for value in filter(None, candidates):
        path = Path(value).expanduser()
        if path.is_file():
            try:
                if version_tuple(capture([path, '--version'])) >= (22, 13, 0):
                    node = path.absolute()
                    break
            except SyncError:
                pass
    require(node, 'Node 22.13+ was not found. Install it or set NODE_BINARY.')
    env['PATH'] = os.pathsep.join([str(node.parent), '/opt/homebrew/bin', env.get('PATH', '')])
    eas = env.get('EAS_BINARY') or shutil.which('eas', path=env['PATH'])
    eas = str(Path(eas).expanduser()) if eas else None
    require(eas and Path(eas).is_file(), 'EAS CLI was not found. Run npm install -g eas-cli, then eas login.')
    require(shutil.which('npm', path=env['PATH']), 'npm was not found alongside Node.')
    require(shutil.which('git', path=env['PATH']), 'git is required to stage the current workspace.')
    require((ROOT / 'node_modules/expo/bin/cli').is_file(), 'Dependencies are missing. Run npm install from the RemoteControl folder.')

    # Reuse the workspace's downloaded toolchain without a user-specific absolute path.
    workspace_tools = Path(env.get('REMOTE_MAC_ANDROID_TOOLS', ROOT.parent.parent / 'PrusnolProjs/testServer/.build/bluetooth-tools')).expanduser()
    sdk_candidates = [env.get('ANDROID_HOME'), env.get('ANDROID_SDK_ROOT'),
                      home / 'Library/Android/sdk', home / 'Android/Sdk', workspace_tools / 'android-sdk']
    sdk = next((Path(p).expanduser() for p in filter(None, sdk_candidates)
                if (Path(p).expanduser() / 'build-tools').is_dir()), None)
    require(sdk, 'Android SDK not found. Set ANDROID_HOME to your SDK directory.')
    versions = sorted((sdk / 'build-tools').iterdir(), key=lambda p: version_tuple(p.name), reverse=True)
    build_tools = next((p for p in versions if (p / 'aapt').is_file() and (p / 'apksigner').is_file()), None)
    require(build_tools, 'Install Android SDK Build-Tools (aapt and apksigner are required).')
    adb = env.get('ADB') or (str(sdk / 'platform-tools/adb') if (sdk / 'platform-tools/adb').is_file()
                             else shutil.which('adb', path=env['PATH']))
    adb = str(Path(adb).expanduser()) if adb else None
    require(adb and Path(adb).is_file(), 'adb not found. Install Android SDK Platform-Tools.')

    java_candidates = [env.get('JAVA_HOME')]
    if Path('/usr/libexec/java_home').is_file():
        try:
            java_candidates.append(capture(['/usr/libexec/java_home', '-v', '17']).strip())
        except SyncError:
            pass
    for base in [home / 'Library/Java/JavaVirtualMachines', Path('/Library/Java/JavaVirtualMachines')]:
        java_candidates.extend(base.glob('*/Contents/Home'))
    java_candidates.extend(workspace_tools.glob('jdk-17*/Contents/Home'))
    java_home = None
    for value in filter(None, java_candidates):
        path = Path(value).expanduser()
        if (path / 'bin/javac').is_file():
            try:
                if version_tuple(capture([path / 'bin/javac', '--version']))[0] == 17:
                    java_home = path
                    break
            except (SyncError, IndexError):
                pass
    require(java_home, 'JDK 17 not found. Set JAVA_HOME to a JDK 17 installation.')
    env.update(JAVA_HOME=str(java_home), ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk),
               CI='1', EAS_NO_VCS='1', EAS_LOCAL_BUILD_SKIP_CLEANUP='1')
    return env, node, Path(eas), Path(adb), build_tools


def choose_usb_device(output, requested=None):
    devices = []
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 2 and any(field.startswith('usb:') for field in fields[2:]):
            devices.append((fields[0], fields[1]))
    if requested:
        matches = [item for item in devices if item[0] == requested]
        require(matches, f'USB device {requested} was not found. Check the cable and USB debugging.')
    else:
        require(devices, 'No USB phone found. Connect it, enable USB debugging, and accept its authorization prompt.')
        require(len(devices) == 1, 'Multiple USB phones found. Run with --serial SERIAL (see adb devices -l).')
        matches = devices
    serial, state = matches[0]
    require(state == 'device', f'USB phone {serial} is {state}. Unlock it and authorize USB debugging, then rerun.')
    return serial


def package_info(text):
    patterns = {'versionCode': r'\bversionCode=(\d+)', 'versionName': r'\bversionName=([^\r\n]+)',
                'firstInstallTime': r'\bfirstInstallTime=([^\r\n]+)', 'lastUpdateTime': r'\blastUpdateTime=([^\r\n]+)'}
    result = {key: match.group(1).strip() for key, pattern in patterns.items()
              if (match := re.search(pattern, text))}
    require('versionCode' in result and 'firstInstallTime' in result, 'Could not read the installed app version/timestamps.')
    result['versionCode'] = int(result['versionCode'])
    return result


def ensure_update_version(installed, version_code):
    require(not installed or installed['versionCode'] <= version_code,
            'The phone has a newer versionCode. Increase android.versionCode in transmitter/app.config.ts; this script never downgrades or uninstalls.')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(stream.read()).hexdigest()


def source_files():
    names = capture(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0')
    selected = []
    for name in sorted(set(filter(None, names))):
        rel = Path(name)
        require(not rel.is_absolute() and '..' not in rel.parts, 'Unsafe path in git source listing.')
        if len(rel.parts) > 1 and rel.parts[0] not in {'transmitter', 'shared'}:
            continue
        if rel.parts[:2] in {('transmitter', 'android'), ('transmitter', 'ios')}:
            continue
        if len(rel.parts) > 4 and rel.parts[:2] == ('transmitter', 'modules') and rel.parts[3] == 'android' and rel.parts[4] in {'build', '.gradle', '.cxx'}:
            continue
        if rel.name.startswith('.env') or rel.name == 'credentials.json' or rel.suffix in {'.keystore', '.jks', '.p12', '.p8', '.mobileprovision', '.provisionprofile'}:
            continue
        source = ROOT / rel
        if not source.exists() or source.is_dir():
            continue
        require(not source.is_symlink(), f'Source symlink is unsupported: {name}. Use a regular source file.')
        selected.append(name)
    return selected


def stage_sources(stage):
    manifest = {}
    for name in source_files():
        source, destination = ROOT / name, stage / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        manifest[name] = digest(destination)
    require('transmitter/App.tsx' in manifest, 'Transmitter source was not staged. Run inside the RemoteControl checkout.')
    (stage / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    return manifest


def verify_current_sources(manifest):
    require(set(source_files()) == set(manifest), 'Source files were added or removed during the build. Rerun to sync the latest code.')
    for rel, expected in manifest.items():
        require((ROOT / rel).is_file() and digest(ROOT / rel) == expected, f'Source changed during the build: {rel}. Rerun to sync the latest code.')


def signing_certificate(apk, build_tools, env):
    result = capture([build_tools / 'apksigner', 'verify', '--print-certs', apk], env=env)
    fingerprints = re.findall(r'certificate SHA-256 digest: ([a-fA-F0-9]+)', result)
    require(fingerprints, 'APK signing certificate was not found.')
    return sorted(set(value.lower() for value in fingerprints))


def source_map_entries(value):
    for section in value.get('sections', []):
        yield from source_map_entries(section['map'])
    sources, contents = value.get('sources', []), value.get('sourcesContent', [])
    require(len(sources) == len(contents), 'Incomplete application source-map contents.')
    yield from zip(sources, contents)


def verify_build(apk, local, manifest, version, version_code, package, build_tools, env):
    badging = capture([build_tools / 'aapt', 'dump', 'badging', apk], env=env)
    expected = f"package: name='{package}' versionCode='{version_code}' versionName='{version}'"
    require(expected in badging, 'Built APK package/version differs from the current Expo config.')
    require("native-code: 'arm64-v8a'" in badging, 'Expected an arm64 Android APK.')
    maps = {path.resolve() for path in local.rglob('index.android.bundle.packager.map')}
    require(len(maps) == 1, 'Cannot verify the built JavaScript source map.')
    source_map = maps.pop()
    built_root = source_map.parent
    while not (built_root / 'transmitter').is_dir():
        require(built_root.parent != built_root, 'Cannot find the isolated build source tree.')
        built_root = built_root.parent
    bundle = built_root / 'transmitter/android/app/build/generated/assets/react/release/index.android.bundle'
    with zipfile.ZipFile(apk) as archive:
        require(archive.read('assets/index.android.bundle') == bundle.read_bytes(), 'Packaged JavaScript does not match the verified build.')
    bundled = set()
    for name, content in source_map_entries(json.loads(source_map.read_text())):
        if content is None or 'node_modules/' in name:
            continue
        clean = name.replace('\\', '/')
        matches = [rel for rel in manifest if clean == rel or clean.endswith('/' + rel)]
        if matches:
            require(len(matches) == 1, 'Ambiguous application source map entry.')
            rel = matches[0]
            require(hashlib.sha256(content.encode()).hexdigest() == manifest[rel], f'Bundled source mismatch: {rel}')
            bundled.add(rel)
    require('transmitter/App.tsx' in bundled, 'The current App.tsx was not found in the compiled bundle.')
    native = [rel for rel in manifest if rel.startswith('transmitter/modules/') and '/android/' in rel]
    for rel in native:
        require((built_root / rel).is_file() and digest(built_root / rel) == manifest[rel], f'Native build input mismatch: {rel}')
    return {'bundledSourcesVerified': len(bundled), 'nativeInputsVerified': len(native), 'packagedBundleVerified': True}


def run_build(args, cwd, env, log):
    with log.open('w') as output:
        os.chmod(log, 0o600)
        child = subprocess.Popen([str(arg) for arg in args], cwd=cwd, env=env,
                                 stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = child.wait()
        except BaseException:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            # The EAS parent can exit before a descendant stops. Kill the
            # remaining process group even when the direct child already exited.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            raise
    require(code == 0, f'Command failed (exit {code}). See the private log: {log}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', default=os.environ.get('ANDROID_SERIAL'), help='Choose a physical USB phone when more than one is connected.')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Check tools, current config, and USB phone without building or installing.')
    mode.add_argument('--build-only', action='store_true', help='Build and verify an arm64 APK without requiring or updating a phone.')
    args = parser.parse_args()
    env, node, eas, adb, build_tools = tools_environment()
    config = json.loads(capture([node, ROOT / 'node_modules/expo/bin/cli', 'config', '--json', '--type', 'public'],
                                cwd=ROOT / 'transmitter', env=env))
    package = config.get('android', {}).get('package')
    version_code = config.get('android', {}).get('versionCode')
    version = config.get('version')
    require(package == 'com.remotemac.transmitter', 'Expected the Remote Mac Android package in Expo config.')
    require(isinstance(version_code, int) and version_code > 0 and isinstance(version, str) and re.fullmatch(r'[\w.+-]+', version), 'Set version and android.versionCode in transmitter/app.config.ts.')

    serial = None
    before = None
    def device(*command):
        return capture([adb, '-s', serial, *command], env=env)
    def installed_path():
        paths = device('shell', 'pm', 'path', package).splitlines()
        return next((line.removeprefix('package:') for line in paths if line.startswith('package:') and line.endswith('/base.apk')), None)

    if not args.build_only:
        serial = choose_usb_device(capture([adb, 'devices', '-l'], env=env), args.serial)
        require(device('shell', 'getprop', 'ro.product.cpu.abi').strip() == 'arm64-v8a', 'This build targets arm64 Android phones.')
        if installed_path():
            before = package_info(device('shell', 'dumpsys', 'package', package))
        ensure_update_version(before, version_code)
    print(f'Ready: Remote Mac {version} (code {version_code}); ' + (f'USB {serial}.' if serial else 'build only.'), flush=True)
    if args.check:
        print('Preflight passed. EAS login/signing will be checked by the local build; no phone changes made.')
        return

    OUTPUT.mkdir(parents=True, exist_ok=True)
    with (OUTPUT / '.sync.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SyncError('Another USB sync/build is running. Wait for it to finish.')
        run = Path(tempfile.mkdtemp(prefix=datetime.now().strftime('%Y%m%d-%H%M%S-'), dir=OUTPUT))
        private = run / 'private'
        private.mkdir(mode=0o700)
        report = {'versionName': version, 'versionCode': version_code, 'package': package, 'installed': False, 'installationVerified': False}
        try:
            baseline = None
            if before:
                old_apk = private / 'previous.apk'
                device('pull', installed_path(), str(old_apk))
                baseline = signing_certificate(old_apk, build_tools, env)
            print('Checking TypeScript…', flush=True)
            run_build([shutil.which('npm', path=env['PATH']), 'run', 'typecheck'], ROOT, env, run / 'typecheck.log')
            stage = private / 'source'
            stage.mkdir()
            manifest = stage_sources(stage)
            (run / 'source-snapshot.json').write_text(json.dumps(manifest, indent=2) + '\n')
            eas_file = stage / 'transmitter/eas.json'
            eas_config = json.loads(eas_file.read_text())
            eas_config.setdefault('cli', {})['appVersionSource'] = 'local'
            profile = eas_config['build']['preview']
            profile['autoIncrement'] = False
            profile.setdefault('android', {})['gradleCommand'] = ':app:assembleRelease -PreactNativeArchitectures=arm64-v8a'
            eas_file.write_text(json.dumps(eas_config, indent=2) + '\n')
            capture(['git', 'init', '--quiet', stage], env=env)
            local = private / 'local-build'
            env.update(EAS_PROJECT_ROOT=str(stage), EAS_LOCAL_BUILD_WORKINGDIR=str(local))
            apk = run / f'remote-mac-{version}.apk'
            print(f'Building current code (usually a few minutes). Log: {run / "build.log"}', flush=True)
            run_build([eas, 'build', '--local', '--platform', 'android', '--profile', 'preview',
                       '--non-interactive', '--output', apk], stage / 'transmitter', env, run / 'build.log')
            report.update(verify_build(apk, local, manifest, version, version_code, package, build_tools, env))
            certificate = signing_certificate(apk, build_tools, env)
            require(not baseline or certificate == baseline, 'APK signing certificate differs from the installed app. Nothing installed; restore the original EAS signing key.')
            report.update(apk=str(apk), apkSha256=digest(apk), signingCertificateSha256=certificate,
                          signingMatchesInstalled=certificate == baseline if baseline else None)
            verify_current_sources(manifest)
            if serial:
                require(choose_usb_device(capture([adb, 'devices', '-l'], env=env), serial) == serial, 'The USB phone disconnected.')
                current_path = installed_path()
                current = package_info(device('shell', 'dumpsys', 'package', package)) if current_path else None
                require(current == before, 'The installed app changed during the build. Rerun to check it again.')
                print('Installing verified APK over USB (saved app data is retained)…', flush=True)
                result = device('install', '-r', str(apk))
                require('Success' in result, 'adb did not confirm installation. The app was not uninstalled.')
                report['installAccepted'] = True
                report['installed'] = True
                after = package_info(device('shell', 'dumpsys', 'package', package))
                require(after['versionCode'] == version_code and after.get('versionName') == version, 'Installed version could not be verified.')
                require(not before or before['firstInstallTime'] == after['firstInstallTime'], 'The original app installation timestamp changed.')
                installed = private / 'installed.apk'
                device('pull', installed_path(), str(installed))
                require(digest(installed) == report['apkSha256'], 'Installed APK does not match the built artifact.')
                report.update(installationVerified=True, deviceSerial=serial, installedPackage=after, installedApkMatches=True)
                print(f'Synced {version} to your phone. Reopen Remote Mac. Saved pairing and settings are retained.', flush=True)
            else:
                print(f'Build verified; no phone changes made. APK: {apk}', flush=True)
        except BaseException as error:
            report['error'] = str(error) or type(error).__name__
            raise
        finally:
            shutil.rmtree(private)
            report['privateBuildWorkspaceRemoved'] = not private.exists()
            (run / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
            print(f'Build/installation report: {run / "report.json"}', flush=True)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))
    try:
        main()
    except KeyboardInterrupt:
        print('\nCancelled. The app was not uninstalled.', file=sys.stderr)
        sys.exit(130)
    except (SyncError, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f'USB sync failed: {error}', file=sys.stderr)
        sys.exit(1)
