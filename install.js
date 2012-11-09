
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs");
const SPAWN = require("child_process").spawn;
const EXEC = require("child_process").exec;
const URL = require("url");
const HTTP = require("http");
const SEMVER = require("./semver");

const DOWNLOAD_BASE_URL = "http://d6ff1xmuve0sx.cloudfront.net/c9local/prod";
const LATEST_URL = "http://static.c9.io/c9local/prod/latest.json";
var HOME_PATH = process.env.HOME;

var SUDO = false;
if (typeof process.env.SUDO_USER === "string" ||
    typeof process.env.SUDO_UID === "string" ||
    typeof process.env.SUDO_GID === "string"
) {
    SUDO = true;

    // If `sudo` is run with `-H`, `process.env.HOME` will be set to `/root`.
    // We need to correct that as the user will want the files in their home dir.
    if (HOME_PATH === "/root") {
        if (PATH.existsSync(PATH.join("/home", process.env.SUDO_USER))) {
            HOME_PATH = PATH.join("/home", process.env.SUDO_USER);
        } else
        if (PATH.existsSync(PATH.join("/Users", process.env.SUDO_USER))) {
            HOME_PATH = PATH.join("/Users", process.env.SUDO_USER);
        }
    }
}

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


var EXISTING_VERSION = false;
var NEW_VERSION = false;
var sigint = false;
var options;

exports.install = function(_options, callback) {

    options = _options || {};

    function install(existingVersion, newVersion, newer) {

        try {
            if (!PATH.existsSync(INSTALL_BASE_PATH)) {
                mkdirsSync(INSTALL_BASE_PATH);
            }
            if (!PATH.existsSync(PATH.join(INSTALL_BASE_PATH, "node_modules"))) {
                FS.mkdirSync(PATH.join(INSTALL_BASE_PATH, "node_modules"));
            }

            EXISTING_VERSION = existingVersion;

            if (newer === true) {
                NEW_VERSION = newVersion;
            } else {
                printMessage("You are running the latest version (" + EXISTING_VERSION + ") of Cloud9 IDE!");
                successAndExit(callback, true);
                return;
            }

        } catch (err) {
            failAndExit(err);
        }

        exports.download(NEW_VERSION, function(err) {
            if (err) failAndExit(err);

            exports.takeLive(NEW_VERSION, function(err) {
                if (err) failAndExit(err);

                fixPermissions(function(err) {
                    if (err) failAndExit(err);

                    installCommand(function(err) {
                        if (err) failAndExit(err);

                        successAndExit(callback);
                    });
                });
            });
        });
    }

    if (options.version) {
        getExitingVersion(function(err, version) {
            if (err) failAndExit(err);
            install(version, options.version, true);
        });
    } else {
        exports.checkLatest(function(err, info) {
            if (err) failAndExit(err);
            install(info.existingVersion, info.version, info.newer);
        });
    }
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

function installCommand(callback) {
    try {
        var installCommandPath = PATH.join(INSTALL_LIVE_PATH, "lib", "install-command.js");
        if (!PATH.existsSync(installCommandPath)) {
            console.log("Skip calling `install-command` as path '" + installCommandPath + "' does not exist!");
            callback(null);
            return;
        }
        require(installCommandPath).installCommand({
            debug: false,
            mode: "production"
        }, function(err) {
            if (err && options.fromDMG !== true) {
                printMessage([
                    "Cloud9 IDE has been installed successfully!",
                    "",
                    "Please add `$HOME/.c9/installs/c9local/bin/c9` to your PATH.",
                    "",
                    "Alternatively you can run the following:",
                    "",
                    "    sudo " + PATH.join(INSTALL_LIVE_PATH, "bin", "c9") + " --install-command"
                ]);
                callback(null);
                return;
            }
            printMessage([
                "Cloud9 IDE has been installed!",
                "",
                "You can start using `c9` on your command line. To see the options, type:",
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
            if (EXISTING_VERSION) {
                printMessage("Unlinking existing Cloud9 IDE version " + EXISTING_VERSION + ".");
            }
            FS.unlinkSync(INSTALL_LIVE_PATH);
        }
        printMessage("Linking new Cloud9 IDE version " + version + ".");
        FS.symlinkSync("c9local-" + version, INSTALL_LIVE_PATH);
        callback(null, INSTALL_LIVE_PATH);
    } catch(err) {
        callback(err);
    }    
}

exports.download = function(version, callback) {
    if (PATH.existsSync(PATH.join(INSTALL_BASE_PATH, "c9local-" + version))) {
        callback(null);
        return;
    }
    installPackage(version, function(err) {
        if (err) {
            callback(err);
            return;
        }
        FS.renameSync(PATH.join(INSTALL_WORKING_PATH, "package"), PATH.join(INSTALL_BASE_PATH, "c9local-" + version));
        FS.rmdirSync(INSTALL_WORKING_PATH);
        callback(null);
    });
}

function installPackage(version, callback) {

    function fail(err) {
        if (!callback) return;
        callback(err);
        callback = null;
    }

    function success() {
        if (!callback) return;
        callback(null);
        callback = null;
    }

    // Backup existing install working directory if it exists. This only happens if install was cancelled
    // half way through and it can probably just be deleted but we keep it just in case.
    if (PATH.existsSync(INSTALL_WORKING_PATH)) {
        FS.renameSync(INSTALL_WORKING_PATH, PATH.join(PATH.dirname(INSTALL_WORKING_PATH), "~c9local~backup-" + (new Date().getTime())));
    }

    var downloadTmpPath = PATH.join(PATH.dirname(INSTALL_WORKING_PATH), "~c9local~download-" + new Date().getTime());
    var downloadURLInfo = URL.parse(DOWNLOAD_BASE_URL + "/c9local-" + version + ".tgz");

    var writeStream = FS.createWriteStream(downloadTmpPath);
    writeStream.on("error", fail);
    writeStream.on("close", function() {

        // TODO: Verify checksum of `downloadTmpPath` against checkum from `LATEST_URL`.

        // Now extract archive.

        FS.mkdirSync(INSTALL_WORKING_PATH);

        console.log("Extracting: " + downloadTmpPath);

        EXEC("tar -xzf " + downloadTmpPath + " -C " + INSTALL_WORKING_PATH, function (error, stdout, stderr) {
            if (error || stderr) {
                callback(new Error(stderr));
                return;
            }
            FS.unlinkSync(downloadTmpPath);
            success();
        });
    });

    console.log("Downloading: " + downloadURLInfo.href);

    var request = HTTP.request({
        host: downloadURLInfo.host,
        port: downloadURLInfo.port,
        path: downloadURLInfo.path,
        method: "GET"
    }, function(res) {
        if (res.statusCode !== 200) {
            fail(new Error("Problem downloading Cloud9 IDE release. Got status code: " + res.statusCode));
            return;
        }
        res.on("data", function(chunk) {
            writeStream.write(chunk, "binary");
        });
        res.on("end", function() {
            writeStream.end();
        });
    });
    request.on("error", fail);
    request.end();
}

function getExitingVersion(callback) {
    var version = false;
    try {
        if (PATH.existsSync(PATH.join(INSTALL_LIVE_PATH, "package.json"))) {
            var descriptor = JSON.parse(FS.readFileSync(PATH.join(INSTALL_LIVE_PATH, "package.json")));
            version = JSON.parse(FS.readFileSync(PATH.join(INSTALL_LIVE_PATH, "package.json"))).version;
        }
    } catch(err) {
        callback(err);
        return;
    }
    callback(null, version);
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
            info.newer = false;
            getExitingVersion(function(err, version) {
                if (err) {
                    callback(err);
                    return;
                }
                if (version) {
                    info.existingVersion = version;
                    if (SEMVER.compare(info.version, info.existingVersion) === 1) {
                        info.newer = true;
                    }
                } else {
                    info.newer = true;
                }
                callback(null, info);
            });
        });
    }).on('error', function(e) {
        callback(e);
    });
}

function failAndExit(err) {
    if (err && !sigint) {
        printMessage(err.stack || err, true);
        if (NEW_VERSION) {
            printMessage("There was an ERROR installing Cloud9 IDE version " + NEW_VERSION + ". See above.");
        } else {
            printMessage("There was an ERROR checking your Cloud9 IDE install. See above.");
        }
    }
    process.exit(1);
}

function successAndExit(callback, isLatest) {
    if (callback)
        callback(isLatest);
    else
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