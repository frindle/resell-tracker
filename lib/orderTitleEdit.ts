// How a form save treats the order title (itemDescription). Pure, so the
// rule is testable.
//
// A title the person typed is recorded in userEditedFields so a later link
// change or sync (lib/linkedItems.ts) never replaces it. A save that did not
// touch the title must not write it either: the form loaded the title before
// a link may have filled it in, and writing that old copy back would undo the
// link's title. Clearing the title hands it back to the links.

export type TitleSaveInput = {
  incoming: unknown;               // body.itemDescription
  edited: unknown;                 // body.__titleEdited (undefined from older clients)
  stored: string | null;           // title in the database now
  editedFields: readonly string[]; // current userEditedFields
};

export type TitleSavePlan = { write: boolean; value: string | null; editedFields: string[] };

export function planTitleSave(i: TitleSaveInput): TitleSavePlan {
  const value = typeof i.incoming === 'string' && i.incoming.trim() ? i.incoming : null;
  const others = i.editedFields.filter(f => f !== 'itemDescription');
  // Older clients send no flag: treat a changed title as an edit.
  const touched = i.edited === undefined ? value !== i.stored : i.edited === true;
  if (!touched) return { write: i.edited === undefined, value, editedFields: [...i.editedFields] };
  return { write: true, value, editedFields: value == null ? others : [...others, 'itemDescription'] };
}
