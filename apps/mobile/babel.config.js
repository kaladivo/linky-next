// NativeWind v4 babel wiring: jsxImportSource lets className work on any
// component; the nativewind preset compiles tailwind classes. babel-preset-expo
// auto-includes the react-native-worklets plugin for reanimated 4.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
  };
};
