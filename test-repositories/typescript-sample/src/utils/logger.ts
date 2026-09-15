export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  constructor(private readonly scope: string) {}

  debug(message: string): void {
    this.write('debug', message);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  private write(level: LogLevel, message: string): void {
    const line = `[${level}] ${this.scope}: ${message}`;
    if (level === 'error') {
      console.error(line);
      return;
    }
    console.log(line);
  }
}
