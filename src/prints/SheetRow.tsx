import { Text, View } from "react-native";
import { sheetStyles } from "./sheetStyles";

/** One label/value line of a box. */
export function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={sheetStyles.rowLine}>
      <Text style={sheetStyles.label}>{label}</Text>
      <Text style={sheetStyles.rowValue}>{value}</Text>
    </View>
  );
}
