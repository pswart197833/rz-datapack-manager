List of item to address before tool is considered complete:

[x] Fix warning in reconstruct test
[x] Fix progress bar breaking at 80%
[ ] Move config file out of the store directory
[ ] configs should have defaults with the ability to change this.
[ ] UI has an assets view but it does not appear to be based on the assets in the store but instead the index file. 
[x] session should be in the session directory and not the store directory
[x] Index reconstruction — data.000 byte-identical
[ ] Add store to compressed archive
[ ] Document API endpoints
[ ] Document how to use the CLI
[x] add comprehensive test suite for all classes
[ ] Extend CLI to have similar functionality as UI
[ ] setup outline on how other tools will plugin to application, such as a image viewer/editor. music player, mape editor, lua editor, cfg editor, rdb editor, etc ..
[ ] add ability to create and apply a patch rather than recompiling and shipping the entire 6Gb packfiles
[ ] add ability to create update files that are compatible with the games update mechanic (this could be the basis for the afore mentioned patch, though the games mechanisim does not tie to specific versions of data files)
[ ] Login for small teams
[ ] Ability for multiple people to work on the same session
[ ] UI must have the ability to switch between showing only modified/added and deleted files such as a diff view.
[ ] Impliment a map viewer that will open map related files and present them to view or edit them. MapDefine.h in mercurialWork/RP/Project_RP/Client/Tool/MapTool/ is a good place to start

