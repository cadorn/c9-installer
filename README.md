Cloud9 IDE Desktop Installer
============================

The NPM desktop installer package for the Cloud9 IDE.


Install
-------

    npm install -g c9
    
    # Until live
    
    npm install -g http://static.c9.io/c9local/prod/c9-0.1.2.tgz


Publish
-------

    npm shrinkwrap
    sm bump
    npm publish

    # Until live

	npm pack    
    scp ./c9-*.tgz cloud9@static.c9.io:~/static/c9local/prod/
