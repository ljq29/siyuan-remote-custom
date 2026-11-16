let customRemote: any;
let earlyTray: any;
let bootProgressReporter: (id: string, state: string, detail?: string) => void = () => {};

const setCustomRemote = (value: any): void => {
    customRemote = value;
};

const getCustomRemote = (): any => customRemote;

const setEarlyTray = (tray: any): void => {
    earlyTray = tray;
};

const getEarlyTray = (): any => earlyTray;

const setCustomBootProgressReporter = (reporter: (id: string, state: string, detail?: string) => void): void => {
    bootProgressReporter = reporter;
};

const reportCustomBootProgress = (id: string, state: string, detail = ""): void => {
    bootProgressReporter(id, state, detail);
};

export {getCustomRemote, setCustomRemote, setCustomBootProgressReporter, reportCustomBootProgress, setEarlyTray, getEarlyTray};
