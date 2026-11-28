// Which logged API errors a user sees, counts and clears. Some are logged with no user (a sync that failed before it knew
// whose run it was, the extension before it paired), and those belong to everyone: leaving them out of the page while the
// daily digest counted them kept them "unread" forever, with no way to open or clear them.
export function errorsVisibleTo(userId: number) {
  return { OR: [{ userId }, { userId: null }] };
}
