Pod::Spec.new do |s|
  s.name           = 'LanDiscovery'
  s.version        = '1.0.0'
  s.summary        = 'Bonjour discovery for Remote Mac'
  s.description    = 'Discovers native Remote Mac receivers on the local network.'
  s.author         = 'Remote Mac'
  s.homepage       = 'https://github.com/remote-mac-control'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.{h,m,mm,swift}'
  s.swift_version  = '5.9'
end
