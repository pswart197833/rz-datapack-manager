List of item to address before tool is considered complete:

[x] Fix warning in reconstruct test
[x] Fix progress bar breaking at 80%
[ ] Move config file out of the store directory
[ ] configs should have defaults with the ability to change this.
[x] session should be in the session directory and not the store directory
[x] Index reconstruction — data.000 byte-identical
[ ] Add store to compressed archive
[ ] Create high level doc describing what the application does.
[ ] Create a more detail doc describing the various aspects of the application and thier function
[ ] Complete the class architecture with all recent changes
[ ] Document API endpoints
[ ] Document how to use the CLI
[ ] add comprehensive test suite for all classes
[ ] Extend CLI to have similar functionality as UI
[ ] setup outline on how other tools will plugin to application, such as a image viewer/editor. music player, mape editor, lua editor, cfg editor, rdb editor, etc ..
[ ] add ability to create and apply a patch rather than recompiling and shipping the entire 6Gb packfiles
[ ] add ability to create update files that are compatible with the games update mechanic (this could be the basis for the afore mentioned patch, though the games mechanisim does not tie to specific versions of data files)
[ ] Login for small teams
[ ] Ability for multiple people to work on the same session
[ ] UI must have the ability to switch between showing only modified/added and deleted files such as a diff view.
[ ] Impliment a map viewer that will open map related files and present them to view or edit them. MapDefine.h in mercurialWork/RP/Project_RP/Client/Tool/MapTool/ is a good place to start
[ ] UI has an assets view but it does not appear to be based on the assets in the store but instead the index file. This does not feel right. Assests or asset store should show you a list of all assets in the store.
