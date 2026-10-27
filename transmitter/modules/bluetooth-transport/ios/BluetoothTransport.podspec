Pod::Spec.new do |s|
  s.name = 'BluetoothTransport'
  s.version = '1.0.0'
  s.summary = 'Native BLE central transport for Remote Mac'
  s.description = 'Framed, bounded Bluetooth LE transport for foreground remote control.'
  s.author = 'Remote Mac'
  s.homepage = 'https://github.com/remote-mac-control'
  s.license = { :type => 'MIT' }
  s.platforms = { :ios => '15.1' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
