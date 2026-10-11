import { StyleSheet, Text } from "react-native";
import { sheetStyles } from "./sheetStyles";
import type { prepareSetup, PublicationDraft } from "./creator";
import { formatSol } from "./price";
import type { StoragePayment } from "../../publications/storage";
import { colors } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { Pill } from "../ui/primitives";
import { actions, onChain, publish as copy } from "../ui/copy";
import type { useTermsAgreement } from "../moderation/store";
import { TermsAgreement } from "../moderation/TermsAgreement";

/** The publish sheet's dock: an unavailable notice, or the status line and action for the current step. */
export function PrintDock({
  canPublish,
  initializing,
  access,
  unreadable,
  availability,
  error,
  status,
  busy,
  draft,
  published,
  valid,
  title,
  detailsError,
  priceError,
  topUp,
  complete,
  storageCanRetry,
  agreement,
  quote,
  onClose,
  change,
  payForStorage,
  publish,
  prepare,
}: {
  canPublish: boolean;
  initializing: boolean;
  access: "fresh" | "saved" | "blocked";
  unreadable: boolean;
  availability: { enabled: boolean; reason?: string };
  error: string;
  status: string;
  busy: boolean;
  draft: PublicationDraft | null;
  published: boolean;
  valid: boolean;
  title: string;
  detailsError: string;
  priceError: string;
  topUp: StoragePayment | null;
  complete: boolean;
  storageCanRetry: boolean;
  agreement: ReturnType<typeof useTermsAgreement>;
  quote: Awaited<ReturnType<typeof prepareSetup>> | null;
  onClose(): void;
  change(): Promise<void>;
  payForStorage(): Promise<void>;
  publish(): Promise<void>;
  prepare(): Promise<void>;
}) {
  return !canPublish && !initializing ? (
    <>
      <Text style={s.noticeTitle}>
        {access === "blocked"
          ? copy.blockedTitle
          : copy.unavailableTitle}
      </Text>
      <Text style={sheetStyles.help}>
        {access === "blocked"
          ? unreadable
            ? error || copy.unreadableBody
            : error || status || copy.blockedBody
          : (availability.reason ?? copy.unavailableBody)}
      </Text>
      {unreadable && (
        <Pill
          label={actions.discardUnreadable}
          disabled={busy}
          onPress={() => void change()}
        />
      )}
      <Pill
        label={actions.backToPhotograph}
        variant="secondary"
        onPress={onClose}
      />
    </>
  ) : (
    <>
      {!!(error || draft?.storageError?.message || status) && (
        <Text
          style={error || draft?.storageError ? sheetStyles.error : sheetStyles.help}
          accessibilityLiveRegion="polite"
        >
          {error || draft?.storageError?.message || status}
        </Text>
      )}
      {!valid && !published && !initializing && !error && (
        <Text style={sheetStyles.help}>
          {!title.trim()
            ? copy.needTitle
            : detailsError
              ? detailsError
              : priceError
                ? priceError
                : copy.needCount}
        </Text>
      )}
      {topUp && (
        <Pill
          label={actions.payStorage(formatSol(topUp.lamports))}
          disabled={busy}
          onPress={() => void payForStorage()}
        />
      )}
      {complete || (published && !storageCanRetry) ? (
        <Pill label={actions.viewPhotograph} onPress={onClose} />
      ) : !published && agreement.agreed !== true ? (
        <TermsAgreement agreed={agreement.agreed} onAgree={() => void agreement.agree()} />
      ) : quote ? (
        <Pill
          label={
            busy
              ? "Publishing…"
              : quote.step === "ready"
                ? draft?.storageError?.kind === "quota"
                  ? actions.checkUpload
                  : actions.completeUpload
                : actions.confirmPublish
          }
          accessibilityHint={onChain.publish}
          disabled={busy || !canPublish}
          onPress={() => void publish()}
        />
      ) : (
        <Pill
          label={
            busy
              ? "Preparing…"
              : initializing
                ? "Loading photograph…"
                : actions.continueToPublish
          }
          disabled={busy || initializing || !valid || !canPublish}
          onPress={() => void prepare()}
        />
      )}
    </>
  );
}

const s = StyleSheet.create({
  noticeTitle: { ...type.body, color: colors.ink },
});
