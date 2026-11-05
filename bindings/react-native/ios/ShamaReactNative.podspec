Pod::Spec.new do |s|
  # Not Shama, which an app may well be called: its module would then hide this one.
  s.name           = 'ShamaReactNative'
  s.version        = '0.0.0'
  s.summary        = "Shama's voice commands for React Native on iOS"
  s.description    = "The microphone, the system's recognizer on the device and its language model, around the core in Rust"
  s.license        = 'Apache-2.0'
  s.author         = 'schaefchens'
  s.homepage       = 'https://github.com/schaefchens/shama'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: 'https://github.com/schaefchens/shama.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # The core as a dynamic framework, which build.sh makes, and sherpa-onnx's, which it fetches;
  # generated/ holds the core's Swift bindings and C header.
  s.vendored_frameworks = 'ShamaCore.xcframework', 'SherpaOnnxC.xcframework'
  # The system's language model exists from iOS 26 on.
  s.weak_frameworks = 'FoundationModels'
  s.frameworks = 'AVFAudio', 'Speech', 'Network'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,swift}'
  # The frameworks bring their own headers.
  s.exclude_files = '*.xcframework/**/*'
end
