import { Pressable, Text } from "react-native";
import { estimate } from "../ui/copy";
import type { PreparedQuote } from "./quoteRefresh";
import { sheetStyles as s } from "./sheetStyles";

export const costSol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(6);

export function CostEstimate({
  prepared,
  expanded,
  onToggle,
  suffix = "",
  label = estimate.label,
  includeAccountCost = true,
}: {
  prepared: Pick<PreparedQuote, "estimatedLamports" | "estimateBreakdown">;
  expanded: boolean;
  onToggle(): void;
  suffix?: string;
  label?: string;
  /** Core transfers create no accounts. */
  includeAccountCost?: boolean;
}) {
  const breakdown = prepared.estimateBreakdown;
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
          {costSol(prepared.estimatedLamports)} SOL{suffix ? ` · ${suffix}` : ""} {expanded ? "−" : "+"}
        </Text>
      </Pressable>
      {expanded && (
        <Text style={s.help}>
          {estimate.networkFee} {costSol(breakdown.networkFee)} SOL ·{" "}
          {includeAccountCost && (
            <>{estimate.accountCost} {costSol(breakdown.accountCost)} SOL ·{" "}</>
          )}
          {estimate.allowance} {costSol(breakdown.allowance)} SOL
        </Text>
      )}
    </>
  );
}
