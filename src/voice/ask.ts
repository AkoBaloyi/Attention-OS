/**
 * Answers a spoken question from the ledger.
 *
 * One entry point, so the read-only boundary is enforced in a single place: this
 * function receives a `VoiceLedgerView`, which has no write methods, and it
 * returns text. There is no path from here to the pipeline, the policy engine or
 * the budget.
 */

import type { WindowCounters } from '../store/ledger.ts';
import {
  budgetBriefing,
  byRoute,
  catchUp,
  explain,
  type Briefing,
  type VoiceLedgerView,
} from './brief.ts';
import { HELP_LINE, UNKNOWN_LINE, matchIntent, type VoiceIntent } from './intent.ts';

export type VoiceAnswer = Briefing & {
  intent: VoiceIntent;
  transcript: string;
};

export function answer(params: {
  transcript: string;
  ledger: VoiceLedgerView;
  windowKey: string;
  counters: WindowCounters;
  focusActive: boolean;
}): VoiceAnswer {
  const { intent, subject } = matchIntent(params.transcript);
  const { ledger, windowKey, counters } = params;

  const briefing = ((): Briefing => {
    switch (intent) {
      case 'catch_up':
        return catchUp(ledger, windowKey, counters);

      case 'interrupts':
        return byRoute(
          ledger,
          windowKey,
          ['push', 'call'],
          'Nothing has interrupted you in this window.',
        );

      case 'digest':
        return byRoute(
          ledger,
          windowKey,
          ['digest'],
          'Nothing is waiting for the digest.',
        );

      case 'held':
        return byRoute(
          ledger,
          windowKey,
          ['hold'],
          'Nothing has been held in this window.',
        );

      case 'budget':
        return budgetBriefing(counters, params.focusActive);

      case 'focus':
        return {
          speech: params.focusActive
            ? `You are in focus mode. The ceiling is ${counters.ceiling}, and ${counters.remaining} of it is left.`
            : `You are not in focus mode. The ceiling is ${counters.ceiling}.`,
          text: '',
        } as Briefing;

      case 'explain':
        return explain(ledger, windowKey, subject);

      case 'help':
        return { speech: HELP_LINE, text: HELP_LINE };

      case 'unknown':
      default:
        return { speech: UNKNOWN_LINE, text: UNKNOWN_LINE };
    }
  })();

  return {
    intent,
    transcript: params.transcript,
    speech: briefing.speech,
    // Some branches build speech first; keep the two in step rather than
    // letting a caller render an empty transcript pane.
    text: briefing.text || briefing.speech,
  };
}
