import { Link } from "expo-router";
import { Text, View } from "react-native";

export default function SettingsScreen() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>Settings</Text>
      <Text>Placeholder — settings land with the settings feature.</Text>
      {/* TEMPORARY: storage-spike dev screen (issue #9), removed with #15. */}
      <Link href="/dev/evolu-spike" style={{ padding: 16 }}>
        <Text style={{ color: "#2dd4bf" }}>Evolu spike (dev)</Text>
      </Link>
    </View>
  );
}
