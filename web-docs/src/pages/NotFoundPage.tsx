export function NotFoundPage({ hash }: { hash: string }) {
  return (
    <div>
      <h1>Not found</h1>
      <p>
        No route matches "#/{hash}". <a href="#/">Back to architecture</a>
      </p>
    </div>
  );
}
