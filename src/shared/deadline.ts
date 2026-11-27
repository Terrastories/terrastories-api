/** Reject with a content-free error if `work` has not settled within `ms`. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline exceeded')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
