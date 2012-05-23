
const PATH = require("path");
const FS = require("fs");
const SPAWN = require("child_process").spawn;
const EXEC = require("child_process").exec;
const URL = require("url");
const HTTP = require("http");
const SEMVER = require("semver");

const DOWNLOAD_BASE_URL = "http://d6ff1xmuve0sx.cloudfront.net/c9local/prod";
const LATEST_URL = "http://static.c9.io/c9local/prod/latest.json";
const INSTALL_PATH = PATH.join(__dirname, "node_modules", "c9local");

var SUDO = false;
if (typeof process.env.SUDO_USER === "string" ||
    typeof process.env.SUDO_UID === "string" ||
    typeof process.env.SUDO_GID === "string"
) {
    SUDO = true;
}

var backupPath = false;
var newVersion = false;
var restoring = false;
var sigint = false;
var installProc = false;

function main() {

    checkLatest(function(err, info) {
        if (err) {
            failAndExit(err);
            return;
        }

        // Only install if no existing `c9local` package or there is a new release available.

        if (PATH.existsSync(PATH.join(INSTALL_PATH, "package.json"))) {
            var descriptor = JSON.parse(FS.readFileSync(PATH.join(INSTALL_PATH, "package.json")));
            
            if (SEMVER.compare(info.version, descriptor.version) === 1) {

                backupPath = PATH.join(INSTALL_PATH, "..", PATH.basename(INSTALL_PATH) + "-" + descriptor.version);
                newVersion = info.version;

                printMessage("Backing up existing install:  (" + INSTALL_PATH + ") to: " + backupPath);

                FS.renameSync(INSTALL_PATH, backupPath);

                // If user cancels process we should try and recover.

                process.once("SIGINT", function() {
                    sigint = true;
                    if (installProc) {
                        installProc.kill();
                    }
                    process.stdout.write("\n\n");
                    printMessage("Cancelling install of Cloud9 IDE version " + info.version + "!");
                    restore();
                });

            } else {
                successAndExit([
                    "You are running the latest version (" + info.version + ") of Cloud9 IDE!",
                ].join("\n"));
                return;
            }
        }

        install(info, function(err) {
            if (err) {
                failAndExit(err);
                return;
            }
            
            // Try to put `c9` onto path.
            EXEC(PATH.join(INSTALL_PATH, "bin", "c9") + " --install-command", function(err, stdout, stderr) {
                if (err) {
                    successAndExit([
                        "Cloud9 IDE has been installed!",
                        "",
                        "RUN THE FOLLOWING to put `c9` on your `PATH`:",
                        "",
                        "    sudo " + PATH.join(INSTALL_PATH, "bin", "c9") + " --install-command"
                    ].join("\n"));
                    return;
                }
                successAndExit([
                    "Cloud9 IDE has been installed!",
                    "",
                    "You can start using the `c9` command:",
                    "",
                    "    c9 -h"
                ].join("\n"));
            });            
        });
    });
}

function install(info, callback) {

    var procCommand = "npm";
    var procArgs = [
        "install",
        info.downloadUrl
    ];
    var cwd = PATH.join(__dirname);

    printMessage("Installing Cloud9 IDE: " + procCommand + " " + procArgs.join(" ") + " (cwd: " + cwd + ")");

    var env = {};
    for (var name in process.env) {
        if (!/^npm_/i.test(name)) {
            env[name] = process.env[name];
        }
    }

    installProc = SPAWN(procCommand, procArgs, {
        cwd: cwd,
        env: env
    });
    installProc.on("error", function(err) {
        callback(err);
    });
    installProc.stdout.on("data", function(data) {
        if (!restoring && !sigint) {
            process.stdout.write(data);
        }
    });
    installProc.stderr.on("data", function(data) {
        if (!restoring && !sigint) {
            process.stderr.write(data);
        }
    });
    installProc.on("exit", function(code) {
        if (code !== 0) {
            callback(new Error("`npm` ran into an issue installing Cloud9 IDE!"));
            return;
        }
        callback(null);
    });
}

function checkLatest(callback) {
    var urlInfo = URL.parse(LATEST_URL);
    HTTP.get({
        host: urlInfo.host,
        port: 80,
        path: urlInfo.path
    }, function(res) {
        if (res.statusCode !== 200) {
            callback(new Error("Did not get status 200 when checking for latest version! Try again in a few minutes."));
            return;
        }
        var data = "";
        res.on("data", function(chunk) {
            data += chunk.toString();
        });
        res.on("end", function() {
            var info = {};
            try {
                info = JSON.parse(data);
            } catch(e) {
                callback(new Error("Did not get status 200!"));
                return;
            }
            info.downloadUrl = DOWNLOAD_BASE_URL + "/c9local-" + info.version + ".tgz";
            callback(null, info);
        });
    }).on('error', function(e) {
        callback(e);
    });
}

function printMessage(message, error) {
    process[(error)?"stderr":"stdout"].write(
        "###\n" +
        "#  " + message.split("\n").join("\n#  ") + "\n" +
        "###\n"
    );
}

function restore() {

    if (restoring) {
        return;
    }
    restoring = true;

    if (backupPath && newVersion) {

        if (PATH.existsSync(INSTALL_PATH)) {

            var brokenInstallBackupPath = PATH.join(INSTALL_PATH, "..", PATH.basename(INSTALL_PATH) + "-" + newVersion);

            printMessage("Backing up broken install (" + INSTALL_PATH + ") to: " + brokenInstallBackupPath);

            FS.renameSync(INSTALL_PATH, brokenInstallBackupPath);
        }
        printMessage("Restoring previous install (" + backupPath + ") to: " + INSTALL_PATH);

        FS.renameSync(backupPath, INSTALL_PATH);

        printMessage("Your existing install of Cloud9 IDE (" + INSTALL_PATH + ") should still be functional.");

    } else {
        if (PATH.existsSync(INSTALL_PATH)) {
            printMessage("Your existing install of Cloud9 IDE (" + INSTALL_PATH + ") should still be functional.");
        } else {
            printMessage("There is no working install of Cloud9 IDE found on your system at: " + INSTALL_PATH);
        }
    }
}

function failAndExit(err) {
    if (!sigint) {
        printMessage(err.stack, true);
        printMessage("There was an ERROR installing Cloud9 IDE. See above.");
    }
    restore();
    process.exit(1);
}

function successAndExit(instructions) {

    function logInstructions() {
        if (instructions) {
            printMessage(instructions);
        }
    }

    if (SUDO) {
        printMessage("Updating permissions: chown -Rf " + process.env.SUDO_UID + ":" + process.env.SUDO_GID + " " + PATH.join(__dirname, "../.."));
        EXEC("chown -R " + process.env.SUDO_UID + ":" + process.env.SUDO_GID + " " + PATH.join(__dirname, "../.."), function(err, stdout, stderr) {
            if (err) {
                if (err) failAndExit(err);
                return;
            }
            logInstructions();
            process.exit(0);
        });
    } else {
        logInstructions();
        process.exit(0);
    }
}

main();
