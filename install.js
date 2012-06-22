
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs");
const SPAWN = require("child_process").spawn;
const EXEC = require("child_process").exec;
const URL = require("url");
const HTTP = require("http");
const SEMVER = require("semver");

const DOWNLOAD_BASE_URL = "http://d6ff1xmuve0sx.cloudfront.net/c9local/prod";
const LATEST_URL = "http://static.c9.io/c9local/prod/latest.json";
const HOME_PATH = process.env.HOME;

if (!HOME_PATH) {
    printMessage("`HOME` environment variable not set!");
    process.exit(1);
}
if (!PATH.existsSync(HOME_PATH)) {
    printMessage("Path `" + HOME_PATH + "` found in `HOME` environment variable does not exist!");
    process.exit(1);
}

const C9_BASE_PATH = PATH.join(HOME_PATH, ".c9");
const INSTALL_BASE_PATH = PATH.join(C9_BASE_PATH, "installs");
const INSTALL_LIVE_PATH = PATH.join(INSTALL_BASE_PATH, "c9local");
const INSTALL_WORKING_PATH = PATH.join(INSTALL_BASE_PATH, "node_modules", "c9local");

var SUDO = false;
if (typeof process.env.SUDO_USER === "string" ||
    typeof process.env.SUDO_UID === "string" ||
    typeof process.env.SUDO_GID === "string"
) {
    SUDO = true;
}

var oldVersion = false;
var newVersion = false;
var sigint = false;

exports.install = function() {

    exports.checkLatest(function(err, info) {
        if (err) failAndExit(err);

        try {
            if (!PATH.existsSync(INSTALL_BASE_PATH)) {
                mkdirsSync(INSTALL_BASE_PATH);
            }
            if (!PATH.existsSync(PATH.join(INSTALL_BASE_PATH, "node_modules"))) {
                FS.mkdirSync(PATH.join(INSTALL_BASE_PATH, "node_modules"));
            }

            oldVersion = info.oldVersion || false;

            if (info.newer === true) {
                newVersion = info.version;
            } else {
                printMessage("You are running the latest version (" + oldVersion + ") of Cloud9 IDE!");
                successAndExit();
                return;
            }

            // Backup existing install working directory if it exists. This only happens if install was cancelled
            // half way through and it can probably just be deleted but we keep it just in case.
            if (PATH.existsSync(INSTALL_WORKING_PATH)) {
                FS.renameSync(INSTALL_WORKING_PATH, PATH.join(INSTALL_BASE_PATH, "node_modules", "~c9local-" + (new Date().getTime())));
            }

        } catch (err) {
            failAndExit(err);
        }

        exports.download(newVersion, function(err) {
            if (err) failAndExit(err);

            exports.takeLive(newVersion, function(err) {
                if (err) failAndExit(err);

                installCommand(function(err) {
                    if (err) failAndExit(err);

                    successAndExit();
                });
            });
        });
    });
}

function installCommand(callback) {
    try {
        require(PATH.join(INSTALL_LIVE_PATH, "lib", "install-command.js")).installCommand({
            debug: false,
            mode: "production"
        }, function(err) {
            if (err) {
                printMessage([
                    "Cloud9 IDE has been installed!",
                    "",
                    "RUN THE FOLLOWING to put `c9` on your `PATH`:",
                    "",
                    "    sudo " + PATH.join(INSTALL_LIVE_PATH, "bin", "c9") + " --install-command"
                ]);
                callback(null);
                return;
            }
            printMessage([
                "Cloud9 IDE has been installed!",
                "",
                "You can start using the `c9` command:",
                "",
                "    c9 -h"
            ]);
            callback(null);
        });
    } catch(err) {
        callback(err);
    }
}

exports.takeLive = function(version, callback) {
    try {
        if (PATH.existsSync(INSTALL_LIVE_PATH)) {
            if (oldVersion) {
                printMessage("Unlinking existing Cloud9 IDE version " + oldVersion + ".");
            }
            FS.unlinkSync(INSTALL_LIVE_PATH);
        }
        printMessage("Linking new Cloud9 IDE version " + version + ".");
        FS.symlinkSync(version, INSTALL_LIVE_PATH);
        callback(null);
    } catch(err) {
        callback(err);
    }    
}

exports.download = function(version, callback) {
    if (PATH.existsSync(PATH.join(INSTALL_BASE_PATH, version))) {
        callback(null);
        return;
    }
    installPackage({
        version: version,
        downloadUrl: DOWNLOAD_BASE_URL + "/c9local-" + version + ".tgz"
    }, function(err) {
        if (err) {
            callback(err);
            return;
        }
        fixPermissions(function(err) {
            if (err) {
                callback(err);
                return;
            }
            FS.renameSync(INSTALL_WORKING_PATH, PATH.join(INSTALL_BASE_PATH, version));
            callback(null);
        });
    });
}

function fixPermissions(callback) {
    if (SUDO) {
        printMessage("Updating permissions: chown -Rf " + process.env.SUDO_UID + ":" + process.env.SUDO_GID + " " + C9_BASE_PATH);
        EXEC("chown -R " + process.env.SUDO_UID + ":" + process.env.SUDO_GID + " " + C9_BASE_PATH, function(error, stdout, stderr) {
            if (error || stderr) {
                callback(new Error(stderr));
                return;
            }
            callback(null);
        });
    } else {
        callback(null);
    }
}

function installPackage(info, callback) {
    var procCommand = "npm";
    var procArgs = [
        "install",
        info.downloadUrl
    ];
    var cwd = INSTALL_BASE_PATH;
    printMessage("Installing Cloud9 IDE: " + procCommand + " " + procArgs.join(" ") + " (cwd: " + cwd + ")");
    var env = {};
    for (var name in process.env) {
        if (!/^npm_/i.test(name)) {
            env[name] = process.env[name];
        }
    }
    var installProc = SPAWN(procCommand, procArgs, {
        cwd: cwd,
        env: env
    });
    installProc.on("error", function(err) {
        callback(err);
    });
    installProc.stdout.on("data", function(data) {
        if (!sigint) {
            process.stdout.write(data);
        }
    });
    installProc.stderr.on("data", function(data) {
        if (!sigint) {
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
    process.once("SIGINT", function() {
        sigint = true;
        installProc.kill();
        process.stdout.write("\n\n");
        printMessage("Cancelling install of Cloud9 IDE version " + info.version + "!");
        if (oldVersion) {
            printMessage("Your existing install of Cloud9 IDE (version: " + oldVersion + ", path: " + INSTALL_LIVE_PATH + ") should still be functional.");
        }
    });
}

exports.checkLatest = function(callback) {
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
            } catch(err) {
                callback(new Error("Error '" + err + "' while parsing JSON: " + data));
                return;
            }
            info.downloadUrl = DOWNLOAD_BASE_URL + "/c9local-" + info.version + ".tgz";
            try {
                info.newer = false;
                if (PATH.existsSync(PATH.join(INSTALL_LIVE_PATH, "package.json"))) {
                    var descriptor = JSON.parse(FS.readFileSync(PATH.join(INSTALL_LIVE_PATH, "package.json")));
                    info.oldVersion = descriptor.version;
                    if (SEMVER.compare(info.version, info.oldVersion) === 1) {
                        info.newer = true;
                    }
                } else {
                    info.newer = true;
                }
            } catch(err) {
                callback(err);
                return;
            }
            callback(null, info);
        });
    }).on('error', function(e) {
        callback(e);
    });
}

function failAndExit(err) {
    if (err && !sigint) {
        printMessage(err.stack || err, true);
        if (newVersion) {
            printMessage("There was an ERROR installing Cloud9 IDE version " + newVersion + ". See above.");
        } else {
            printMessage("There was an ERROR checking your Cloud9 IDE install. See above.");
        }
    }
    process.exit(1);
}

function successAndExit() {
    process.exit(0);
}

function printMessage(message, error) {
    process[(error)?"stderr":"stdout"].write(
        "###\n" +
        "#  " + ((typeof message === "string")?message.split("\n"):message).join("\n#  ") + "\n" +
        "###\n"
    );
}

function mkdirsSync(path) {
    path = path.split("/");
    var parts = [];
    while (path.length > 0 && !PATH.existsSync(path.join("/"))) {
        parts.push(path.pop());
    }
    if (parts.length === 0) return;    
    while (parts.length > 0) {
        path.push(parts.pop());
        if (path.length > 1) {
            FS.mkdirSync(path.join("/"));
        }
    }
}

if (require.main === module && !PATH.existsSync(PATH.join(__dirname, "..", "cloud9"))) {
    exports.install();
}
