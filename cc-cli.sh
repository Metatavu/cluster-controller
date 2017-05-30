#!/bin/sh

SCRIPTNAME=$0
HOST=127.0.0.1
PORT=3000

print_usage() 
{
  echo "Usage: $SCRIPTNAME {group-up|group-down|cluster-restart|cluster-fail-safe-start|cluster-fail-safe-stop|cluster-update-war|help} [arguments]" >&2
}

do_get()
{
  curl http://$HOST:$PORT$1
}

group_up() 
{
  do_get /group/$1/up
}

group_down() 
{
  do_get /group/$1/down
}

cluster_restart() 
{
  do_get /cluster/restart
}

cluster_fail_safe_start() 
{
  do_get /cluster/failsafe/start/$1
}

cluster_fail_safe_stop() 
{
  do_get /cluster/failsafe/stop
}

cluster_update_war() 
{
  do_get /cluster/update/$1
}

case "$1" in 
  group-up)
    if [ "$#" -ne 2 ]; then
      echo "Usage: $SCRIPTNAME $1 GROUP_NAME"
      exit 1
    fi
  
    group_up $2
  ;;
  group-down)
    if [ "$#" -ne 2 ]; then
      echo "Usage: $SCRIPTNAME $1 GROUP_NAME"
      exit 1
    fi
  
    group_down $2
  ;;
  cluster-restart)
    if [ "$#" -ne 1 ]; then
      echo "Usage: $SCRIPTNAME $1"
      exit 1
    fi
    
    cluster_restart
  ;;
  cluster-fail-safe-start)
    if [ "$#" -ne 2 ]; then
      echo "Usage: $SCRIPTNAME $1 WAR_NAME"
      exit 1
    fi
    
    group_up failsafe
    cluster_fail_safe_start $2
  ;;
  cluster-fail-safe-stop)
    if [ "$#" -ne 1 ]; then
      echo "Usage: $SCRIPTNAME $1"
      exit 1
    fi
    
    group_down failsafe
    cluster_fail_safe_stop
    group_up failsafe
  ;;
  cluster-update-war)
    if [ "$#" -ne 2 ]; then
      echo "Usage: $SCRIPTNAME $1 WAR_NAME"
      exit 1
    fi
    
    cluster_update_war $2
  ;;
  help)
    print_usage
  ;;
  *)
    print_usage
    exit 1
  ;;
esac
