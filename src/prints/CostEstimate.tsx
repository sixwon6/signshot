import { Pressable, Text } from "react-native";
import { estimate } from "../ui/copy";
import { costRows, type Estimate } from "./price";
import { sheetStyles as s } from "./sheetStyles";

export const costSol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(6);

export function CostEstimate({
  prepared,
  expanded,
  onToggle,
  suffix = "",
  label = estimate.label,
  includeAccountCost = true,
  apart = 0n,
}: {
  prepared: Estimate;
  expanded: boolean;
  onToggle(): void;
  suffix?: string;
  label?: string;
  /** Core transfers create no accounts. */
  includeAccountCost?: boolean;
  /** Inside the estimate but shown on its own row: a purchase's price. */
  apart?: bigint;
}) {
  const rows = costRows(prepared, apart);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? estimate.hide : estimate.show}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={s.costRow}
      >
        <Text style={s.label}>{label}</Text>
        <Text style={s.costValue}>
          {costSol(rows.cost)} SOL{suffix ? ` · ${suffix}` : ""} {expanded ? "−" : "+"}
        </Text>
      </Pressable>
      {expanded && (
        <Text style={s.help}>
          {estimate.networkFee} {costSol(rows.networkFee)} SOL ·{" "}
          {includeAccountCost && (
            <>{estimate.accountCost} {costSol(rows.accounts)} SOL ·{" "}</>
          )}
          {estimate.allowance} {costSol(rows.allowance)} SOL
        </Text>
      )}
    </>
  );
}
