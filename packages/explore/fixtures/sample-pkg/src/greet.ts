/** Public greeting helper used by the explore-agent smoke fixture. */
export function greet(name: string, shout = false): string {
  const message = `hello, ${name}`;
  return shout ? message.toUpperCase() : message;
}

export type GreetOptions = {
  name: string;
  shout?: boolean;
};
