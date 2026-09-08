// One place that decides whether a sheet PRESENTS or merely renders.
//
// THE BUG THIS EXISTS FOR. iOS presents one modal at a time. Asking for a second
// while the first is up — from a control inside it, which is the natural way to
// write it — gets the second presentation dropped, and what is left behind is a
// modal window with no content: invisible, swallowing every touch, and impossible
// to dismiss because its backdrop was never laid out. Reported from device as the
// run editor's "assign athlete" doing nothing and then freezing History.
//
// Five places in this app opened a modal from inside a modal, so the fix is not a
// patch at the call site. A sheet that is already inside a presented modal must not
// present again; it must render into the one that is already there. `embedded` says
// which situation it is in, and this component is the only thing that knows what
// that means.
//
// NOT a fix by hiding the parent and showing the child, which was the other option.
// That is two presentation operations in one commit — a dismiss racing a present —
// and it trades a reliable failure for an intermittent one. Switching the CONTENT of
// a host that is already up changes no presentation at all.

import type { ReactNode } from 'react';
import { Modal, StyleSheet, View } from 'react-native';

export function SheetHost({
  visible,
  embedded = false,
  onRequestClose,
  animationType = 'fade',
  children,
}: {
  visible: boolean;
  /** True when something up the tree has already presented a modal. */
  embedded?: boolean;
  onRequestClose: () => void;
  /** Only used when this actually presents; an embedded sheet animates nothing. */
  animationType?: 'fade' | 'slide' | 'none';
  children: ReactNode;
}) {
  if (embedded) {
    // Already inside a presented modal: fill it, do not present again.
    //
    // AND THE CALLER MUST BE A DIRECT CHILD OF THAT MODAL. This is the one way an
    // embedded sheet differs from the Modal it replaces, and it is easy to miss: a
    // Modal is positioned against the WINDOW wherever it sits in the tree, while this
    // fills its PARENT. Written somewhere deep — inside a card, inside a row — it is
    // laid out against that box instead of the screen, and the sheet is silently
    // squeezed into a frame it was never designed for. It cost a confirm button its
    // label the first time, which is a quiet enough failure to be worth this comment.
    return visible ? <View style={StyleSheet.absoluteFill}>{children}</View> : null;
  }
  return (
    <Modal visible={visible} transparent animationType={animationType} onRequestClose={onRequestClose}>
      {children}
    </Modal>
  );
}
