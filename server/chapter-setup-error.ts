/** Only private, unpublished setup may be rebuilt. Never relax an accepted route. */
export class ChapterSetupError extends Error {
  constructor(readonly code:string, readonly evidence:unknown) {
    super(JSON.stringify({code,evidence}));
    this.name='ChapterSetupError';
  }
}
