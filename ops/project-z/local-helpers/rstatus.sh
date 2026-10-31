#!/bin/bash
# usage: rstatus.sh NAME [TAIL_LINES]   (state + tail of a background run started by rbg.sh)
NAME=$1; N=${2:-25}
OUT=/home/factory-user/repos/fzv-int-out
/home/factory-user/repos/project-z-worker-notes/rssh.sh "cd $OUT; if [ -e $NAME.exit ]; then echo STATE=FINISHED exit=\$(cat $NAME.exit); elif [ -e $NAME.log ]; then echo STATE=RUNNING; elif [ -e $NAME.queued ]; then echo STATE=WAITING_FOR_LOCK; else echo STATE=UNKNOWN; fi; test -e $NAME.log && tail -n $N $NAME.log"
