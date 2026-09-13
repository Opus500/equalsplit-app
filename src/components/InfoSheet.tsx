// A short line on screen, the full explanation one tap away.
//
// THE SCREEN IS NOT THE MANUAL. This app has several places where the honest
// caveat is a paragraph — why a video time is not a gate time, what a lockout
// does, what "join" does to a lap — and each of them used to sit in the main view,
// permanently, in 11pt grey. Written for the developer, read by nobody after the
// second session, and read by a reviewer as an app that is still explaining
// itself. The information is not the problem; its address is.
//
// So: the one-line version stays where it was, and the paragraph moves behind
// "Learn more". Nothing is cut. A coach who wants the reasoning gets all of it,
// and one who has read it once stops paying for it.
//
// PRESENTS A SHEET, so it must not be rendered inside another presented modal —
// see SheetHost for why iOS drops the second presentation. Every site that uses it
// is a tab or an overlay View, and verify-reachable's nested-sheet sweep reads
// this file as a sheet owner and will flag any future site that gets it wrong.

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SheetHost } from './SheetHost';
import { FAINT, INK, INK_2, INTERACTIVE, LINE, SURFACE } from '../theme';

export function LearnMore({
  title,
  body,
  label = 'Learn more',
}: {
  title: string;
  /** Paragraphs. A single string is one paragraph. */
  body: string | string[];
  /** The link text. Kept short: it sits at the end of a one-line caveat. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const paragraphs = Array.isArray(body) ? body : [body];
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.link, pressed && styles.dim]}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${title}`}
      >
        <Text style={styles.linkText}>{label}</Text>
      </Pressable>

      <SheetHost visible={open} onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.title}>{title}</Text>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
              {paragraphs.map((p, i) => (
                <Text key={i} style={styles.para}>
                  {p}
                </Text>
              ))}
            </ScrollView>
            <Pressable
              onPress={() => setOpen(false)}
              style={({ pressed }) => [styles.done, pressed && styles.dim]}
            >
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </SheetHost>
    </>
  );
}

/**
 * A one-line note with its Learn more beside it. The common shape, so the sites
 * that use it do not each lay out the same row.
 */
export function NoteWithMore({
  note,
  title,
  body,
  tone = 'faint',
}: {
  note: string;
  title: string;
  body: string | string[];
  /** faint is the default caption grey; ink is for a note that must be read. */
  tone?: 'faint' | 'ink';
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.note, tone === 'ink' && styles.noteInk]}>{note}</Text>
      <LearnMore title={title} body={body} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  note: { flex: 1, color: FAINT, fontSize: 11.5, lineHeight: 16 },
  noteInk: { color: INK_2, fontSize: 12.5, lineHeight: 18 },
  // 44pt tall whatever the text beside it: an inline link is the classic too-small
  // target, and padding is cheaper than a missed tap.
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, marginRight: -8 },
  linkText: { color: INTERACTIVE, fontSize: 12, fontWeight: '700' },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: SURFACE,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: LINE,
    padding: 18,
    maxHeight: '80%',
  },
  title: { color: INK, fontSize: 17, fontWeight: '800', marginBottom: 10 },
  scroll: { flexGrow: 0 },
  body: { gap: 12 },
  para: { color: INK_2, fontSize: 14, lineHeight: 21 },
  done: {
    marginTop: 16,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: '#1d4ed8',
  },
  doneText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  dim: { opacity: 0.6 },
});
