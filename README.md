# Network Sync

Network Sync est une application de transfert **unidirectionnel** des dossiers d'un NAS. Elle fusionne plusieurs sources vers une destination unique, en mode **copie (par défaut)** ou **déplacement**, avec arborescence conservée ou destination à plat. Un troisième type d'opération recherche les doublons de contenu dans un répertoire. Elle expose un tableau de bord Angular via Node.js/Express.

## Fonctionnalités

**Compatibilité volumes USB Synology :** sur une destination **exFAT reconnue**, Network Sync optimise automatiquement les nouvelles copies en **écriture directe exclusive** (`wx`, une seule copie). La création exclusive protège les fichiers existants contre tout écrasement, même s'ils apparaissent pendant l'opération. Le fichier définitif peut cependant être **visible et incomplet pendant le transfert** ; il est supprimé en cas d'erreur/annulation lorsque le programme peut confirmer qu'il lui appartient. Un arrêt brutal du NAS ou du conteneur peut laisser un fichier partiel : ne pas considérer les noms visibles en cours de copie comme des fichiers terminés. Les autres volumes conservent la publication atomique via un fichier temporaire et un lien physique ; si les liens ne sont pas pris en charge, la copie exclusive de repli reste possible. L'option d'écrasement conserve le transfert temporaire et le renommage. Les dossiers internes `@eaDir` et `#recycle` ne sont pas parcourus.


- Plusieurs tâches indépendantes, chacune avec 1 à 30 dossiers sources et une destination.
- Destination avec **arborescence relative conservée** (par défaut) ou **fichiers à plat**, directement à la racine.
- Opération **copier** (défaut, conserve les sources) ou **déplacer** (supprime les fichiers sources après copie et vérification SHA-256).
- Conflits paramétrables : **renommer** (par défaut), **ignorer**, **écraser**.
- Comparaison des fichiers au même chemin : **nom et taille** par défaut, ou **SHA-256** en option pour distinguer deux fichiers de taille identique. En mode déplacement, SHA-256 est imposé avant toute suppression.
- **Détection de doublons** : inventaire récursif d'un dossier, regroupement par taille puis SHA-256 ; revue des groupes avec choix du fichier à conserver et suppression manuelle des autres copies.
- Renommage stable, par exemple `photo__0a6c2d8e13.jpg` : une exécution répétée ne produit pas de copies supplémentaires si le contenu n'a pas changé.
- Exécution manuelle, simulation sans écriture, annulation, progression en octets (y compris pendant les gros fichiers) et historique des 30 dernières exécutions.
- Planification cron facultative avec fuseau horaire (par défaut `Europe/Paris`).
- Filtrage facultatif par extensions, avec présélections **images**, **vidéos**, **documents**, sélection individuelle et extensions personnalisées.
- **Filtrage par taille** : fichiers strictement supérieurs ou inférieurs à un seuil réglable en Mo (1 Mo = 1 048 576 octets).
- **Filtrage du nom** : expression régulière JavaScript facultative sur le nom de fichier (extension incluse), avec option pour ignorer la casse. Tous les filtres sont cumulables.
- **Exclure les Live Photos** : filtre facultatif fondé sur les métadonnées QuickTime Apple des clips MOV/MP4/M4V ; aucune exclusion des vidéos ordinaires selon leur seule taille ou durée.
- **Pause / reprise** des synchronisations et simulations actives : l'exploration est suspendue et la copie peut être suspendue entre les blocs de données, sans abandonner le fichier temporaire.
- Explorateur des répertoires autorisés, interface responsive, authentification HTTP Basic.
- En mode **copie**, aucune suppression de fichiers sources ; en mode **déplacement**, suppression individuelle après vérification, sans purge des fichiers exclus ou ignorés. Liens symboliques ignorés dans les sources, refusés dans les chemins de destination.

## Optimisation des écritures sur exFAT USB

Le paramètre d'environnement `NETWORK_SYNC_WRITE_MODE` vaut `auto` par défaut et peut être défini dans `.env` avec Docker Manager :

- `auto` : écriture directe si le système de fichiers est identifié comme exFAT (type Linux exFAT ou montage FUSE explicitement nommé exFAT), méthode traditionnelle sinon.
- `direct` : impose l'écriture directe exclusive, utile si un pilote Synology expose exFAT simplement comme `fuseblk` ; à utiliser uniquement sur le volume prévu, après avoir vérifié le format.
- `atomic` : impose le mode historique (fichier temporaire puis publication sans remplacement ; risque de double copie si les liens physiques sont indisponibles).

L'interface indique **« Mode optimisé : écriture directe exclusive (une seule copie) »** pendant la copie si le mode est bien employé. Pour des volumes de destination mixtes, préférer `auto` ; l'override `direct` s'applique à tous les nouveaux fichiers des tâches du conteneur, pas seulement au disque USB.

**Compromis :** en `direct`, l'écriture est exclusive mais **pas atomique** pour les lecteurs extérieurs. Des fichiers partiels peuvent subsister après une coupure d'alimentation ou un arrêt forcé. Après un tel incident, vérifier les fichiers concernés avant de relancer une tâche utilisant la simple comparaison par taille ; SHA-256 est préférable. Une suppression de source en mode déplacement n'intervient qu'après vérification complète du fichier de destination par SHA-256.

## Exemple Synology

Les sources :

    /volume1/OneDrive/OneDrive Damien/Images Damien/2026/01/photo.jpg
    /volume1/OneDrive/OneDrive Ludivine/Images/2026/01/photo.jpg

La destination :

    /volumeUSB1/usbshare/Photos

produisent, si les fichiers sont différents :

    /volumeUSB1/usbshare/Photos/2026/01/photo.jpg
    /volumeUSB1/usbshare/Photos/2026/01/photo__<identifiant>.jpg

Les autres sources du job utilisent la même racine de destination. En mode **à plat**, ces fichiers sont placés directement dans `/volumeUSB1/usbshare/Photos`, sans le chemin `2026/01/`. Les chemins se saisissent **sans caractères d'échappement shell** : les espaces sont acceptés tels quels.

## Installation Docker / Docker Manager

1. Cloner le dépôt ou importer `docker-compose.yml` dans Docker Manager.
2. Copier `.env.example` en `.env` et renseigner **obligatoirement** `APP_USERNAME` et un `APP_PASSWORD` d'au moins 12 caractères.
3. Définir `PUID` et `PGID` avec l'utilisateur Synology autorisé à écrire sur la destination USB, puis créer `./data` et lui accorder l'écriture. Vérifier également l'accès aux dossiers sources. Si une ACL DSM autorise l'accès uniquement à un **groupe secondaire** (par exemple `administrators` = GID `101`), définir `NAS_EXTRA_GID=101` dans `.env`. Le Compose ajoute ce groupe avec `group_add`, sans démarrer le conteneur en root.
4. Adapter uniquement les **volumes Docker accessibles** et, si nécessaire, `SYNC_MOUNT_ROOTS` dans `docker-compose.yml`. Il n'y a **aucune source ni destination de synchronisation prédéfinie** : les règles se créent dans l'interface.
5. Démarrer le conteneur puis ouvrir `http://IP_DU_NAS:8088`.

Exemple de lancement :

    cp .env.example .env
    # Modifier .env, puis :
    mkdir -p data
    sudo chown 1026:100 data  # Adapter au PUID:PGID réel
    docker compose up -d --build

**DNS npm sur Synology :** la compilation utilise par défaut `build.network: host` (`NETWORK_SYNC_BUILD_NETWORK=host`) pour contourner les erreurs DNS Docker de type `EAI_AGAIN registry.npmjs.org`. Cela ne modifie pas le réseau du conteneur en fonctionnement. Si la résolution DNS échoue également sur le réseau hôte, corriger la configuration DNS du NAS : ce paramètre ne pourra pas la compenser.

Diagnostic à lancer sur le NAS :
```sh
docker run --rm --network host node:22-alpine npm ping --registry=https://registry.npmjs.org
docker run --rm node:22-alpine npm ping --registry=https://registry.npmjs.org
```

Pour relancer après un blocage (interrompre d'abord le build précédent avec Ctrl+C) :
```sh
cd /volume1/docker/network-sync
git pull --ff-only
docker compose build --progress plain network-sync
docker compose up -d --no-build --force-recreate network-sync
```

**Sans budget GitHub Actions :** le fichier Compose construit désormais l'image `network-sync:local` **directement sur le NAS**. Les workflows GitHub ne sont plus déclenchés automatiquement par les commits ; ils ne peuvent être lancés que manuellement si le budget le permet.

**Docker Manager :** sélectionner le projet `/volume1/docker/network-sync`, la branche `main`, le dépôt `https://github.com/albaintor/network-sync` et le mode **Build local : docker compose build** (`compose-build`). Puis lancer **Déployer** : le manager met à jour le dépôt et construit le conteneur sur le NAS. Ne pas laisser le projet en mode **Image préconstruite** pour cette version : l'image GHCR ne contient pas les derniers correctifs.

### Accès aux dossiers Synology : ACL et groupes supplémentaires

Une permission DSM peut être attribuée au groupe `administrators` plutôt qu'à l'utilisateur directement. Sur certains NAS Synology, le dossier apparaît avec un mode Unix `d---------+` ; les droits effectifs proviennent alors des ACL Synology. Docker ne reprend pas automatiquement les groupes secondaires de l'utilisateur du NAS : `user: "1026:100"` lance le processus avec `gid=100` seulement.

Exemple : si `id damien` affiche `groups=100(users),101(administrators)` et `synoacltool -get /volume1/OneDrive` accorde `rwx` à `administrators`, renseigner dans le fichier `.env` existant :

```dotenv
PUID=1026
PGID=100
NAS_EXTRA_GID=101
```

Puis recréer le conteneur (aucune nouvelle compilation n'est nécessaire si l'image est déjà disponible) :

```sh
docker compose up -d --no-build --force-recreate
docker exec network-sync id
docker exec network-sync ls /volume1/OneDrive
```

La première commande `docker exec` doit afficher `groups=100(users),101` (l'affichage du nom du groupe dépend de l'image). **Attention :** ajouter `101` donne au conteneur les droits ACL du groupe administrateurs sur **tous les dossiers montés dans le conteneur**. Limiter les montages `/volume1` et `/volumeUSB1` aux dossiers nécessaires si possible. Ne pas utiliser `root` ou `chmod -R 777` pour contourner les ACL.

### Montages et chemins

Le Compose d'exemple fournit :

| Hôte Synology | Conteneur | Mode |
| --- | --- | --- |
| `/volume1` | `/volume1` | Lecture/écriture |
| `/volumeUSB1` | `/volumeUSB1` | Lecture/écriture |
| `./data` | `/app/data` | Lecture/écriture (configuration et historique) |

Ainsi les chemins indiqués dans l'interface sont les chemins Synology exacts. **Les montages sont des zones accessibles, pas des synchronisations déjà configurées**. Au premier lancement, aucune règle n'est créée. Dans l'interface : **Nouvelle synchronisation** → saisir un nom → **Parcourir** pour explorer les sous-dossiers (un clic ouvre le dossier, il ne valide pas la sélection) → **Ajouter** directement sur la ligne d'un dossier pour l'enregistrer comme source (sans fermer l'explorateur), puis **Terminer** → **Parcourir** pour choisir la destination (ou créer un sous-dossier) → définir les conflits et la planification → **Enregistrer**. On peut modifier ou supprimer chaque règle ultérieurement.

Les volumes accessibles se déclarent **une fois dans Docker** (par défaut `/volume1` et `/volumeUSB1`) : leur contenu se parcourt depuis l'IHM sans renseigner de chemin dans le Compose par synchronisation. Pour ajouter un autre volume, le monter dans Docker et ajouter son chemin dans `SYNC_MOUNT_ROOTS` (séparateur `;`). Le volume doit être accessible en lecture pour les sources et en écriture pour les destinations ; le processus utilisateur du conteneur doit avoir les droits Synology correspondants. Les deux montages de l'exemple sont en lecture/écriture car chaque volume peut servir de destination. **Restreindre les montages à des répertoires dédiés si cet accès est trop large.** Un chemin hors de ces volumes est refusé, tout comme une destination imbriquée dans une source (ou inversement).

### Copier / déplacer et arborescence / à plat

Deux options indépendantes sont enregistrées pour chaque tâche :

- **Opération** : `copy` (valeur par défaut) conserve les fichiers sources ; `move` copie le fichier à destination, vérifie par **SHA-256** qu'il est identique, puis supprime le fichier source. Les sous-dossiers sources vides sont retirés, mais pas la racine source.
- **Organisation** : `tree` (valeur par défaut) utilise le chemin relatif à chaque source (ex. `2026/01/photo.jpg`) ; `flat` conserve uniquement le nom du fichier (`photo.jpg`) à la racine de destination. Les collisions suivent les règles habituelles : renommer, ignorer ou écraser. En mode copie à plat, sélectionner SHA-256 pour distinguer deux fichiers différents ayant la même taille.

En mode déplacement, un fichier déjà présent et réellement identique est supprimé de sa source après vérification SHA-256, sans être recopié. Un fichier différent ignoré par la politique de conflit **reste à la source**. L'option « comparer par taille » peut rester sélectionnée pour la copie ; **le déplacement vérifie toujours le contenu pour autoriser une suppression**, même si la comparaison par taille a été choisie. Les fichiers exclus par les filtres ne sont jamais déplacés.

**Important :** le déplacement nécessite des droits de suppression dans les sources. Si l'écriture, la vérification ou la suppression échoue, la source est conservée et une erreur est remontée. Une destination déjà copiée peut subsister si la suppression de sa source échoue. Les déplacements sur des sources imbriquées sont refusés. Utiliser d'abord **Simuler** pour vérifier les collisions ; la simulation n'écrit ni ne supprime aucun fichier. Une tâche planifiée en mode déplacement exécutera ces suppressions automatiquement.

Les anciennes tâches sans `operation` ni `layout` restent en mode `copy` / `tree`.

### Recherche et suppression manuelle des doublons

1. Dans l'interface, choisir **Recherche de doublons** ou sélectionner le type d'opération **Détecter les doublons** lors de la création d'une tâche.
2. Choisir **un seul dossier source** ; aucun dossier destination n'est nécessaire. L'analyse est manuelle et parcourt récursivement ses sous-dossiers.
3. L'analyse répertorie les tailles, puis ne calcule l'empreinte **SHA-256 que pour les tailles présentes plusieurs fois**. Elle signale les fichiers au contenu strictement identique **quel que soit leur nom** ; deux fichiers de même taille mais de contenus différents ne sont pas des doublons. Les liens symboliques, `@eaDir` et `#recycle` sont ignorés. Les liens physiques vers les mêmes données ne sont pas proposés comme stockage récupérable.
4. Les résultats affichent, pour chaque groupe, la taille, le SHA-256 et la liste des chemins complets. Le premier fichier est **présélectionné à conserver** (modifiable par un bouton radio). Cocher explicitement les groupes à nettoyer, puis cliquer sur **Supprimer les doublons sélectionnés**.
5. Une boîte de confirmation indique le nombre de fichiers et l'espace récupérable théorique. Avant suppression, le serveur **vérifie de nouveau tous les fichiers d'un groupe**, y compris le fichier à conserver, par identité et SHA-256 ; en cas de changement, il **ne supprime aucun fichier de ce groupe**. Les suppressions peuvent être partielles si un autre groupe échoue ou si un incident survient pendant les suppressions : un bilan est affiché et une nouvelle analyse est nécessaire.

**Sécurité :** aucune suppression n'est automatique à l'issue d'une analyse ni lors d'une planification. Les résultats comportant des erreurs sont consultables mais **non supprimables**. La confirmation ne traite que les groupes explicitement choisis ; le nom du fichier à conserver doit appartenir aux fichiers observés lors de cette analyse. Les résultats sont conservés **en mémoire** et disparaissent après redémarrage du conteneur, modification de la tâche ou suppression ; il faut alors relancer l'analyse. L'opération exige des droits d'écriture sur le dossier source. Une limite de 200 000 fichiers examinés par recherche évite une consommation de mémoire excessive.

L'API expose `GET /api/jobs/:id/duplicates` (groupes et identifiant du scan) et `POST /api/jobs/:id/duplicates/delete` avec `{"scanId":"...","selections":[{"groupId":"...","keep":"/chemin/à/conserver"}]}`. Le serveur refuse les chemins et groupes étrangers aux résultats de l'analyse.

### Filtrage des extensions

Chaque règle peut inclure **tous les fichiers** (par défaut, y compris les anciennes règles) ou **une sélection explicite d'extensions**. Dans la configuration, choisir « Filtrer par extension », puis cocher les groupes **Images**, **Vidéos** et **Documents**, sélectionner des extensions individuellement ou ajouter une extension personnalisée (sans ou avec son point). Les extensions sont normalisées en minuscules et le filtrage est insensible à la casse, y compris pour les noms `.JPG` ou `.MP4`. Une extension composée comme `tar.gz` est également acceptée. Les fichiers exclus ne sont pas copiés et figurent dans le compteur « exclus ». Les dossiers restent parcourus de manière récursive.

### Exclure les Live Photos Apple

Dans la configuration d'une tâche de **copie** ou de **déplacement**, cocher **« Exclure les Live Photos »** pour ignorer les petits clips qui accompagnent les photos animées d'un iPhone. L'option est **désactivée par défaut**, y compris pour les tâches déjà enregistrées.

- Examine uniquement les conteneurs `.mov`, `.mp4` et `.m4v`, sans tenir compte de la casse. Les séquences des Live Photos sont habituellement en **MOV**.
- Après les contrôles d'extension, de taille et de nom, recherche dans l'atome QuickTime `moov` les clés `com.apple.quicktime.content.identifier` et `com.apple.quicktime.still-image-time`. Ces marqueurs associent le clip à la photo fixe et caractérisent les Live Photos Apple ; l'analyse ignore les données vidéo volumineuses de `mdat`.
- Ne repose **ni sur la durée ni sur la taille**. Les vraies vidéos courtes sans marqueur sont conservées, ainsi que les photos JPEG/HEIC et les vidéos d'autres formats.
- Les clips reconnus apparaissent dans le compteur `exclus`, avec un sous-compteur **Live Photos**. Ils restent à la source, y compris en mode déplacement. La simulation applique le même filtre.
- Les métadonnées absentes ou supprimées lors d'un export/transcodage empêchent une détection fiable : en l'absence de marqueur identifiable, la vidéo est conservée. L'inspection borne la lecture du bloc `moov` à 64 Mio pour éviter une analyse trop coûteuse.

Ce filtre est indépendant de la recherche de doublons et s'additionne aux filtres habituels.

### Filtres de taille et de nom

Dans la fenêtre de configuration d'une règle, en complément du choix des extensions :

- **Taille** : sélectionner « Toutes les tailles » (défaut), « Plus grand que (>) » ou « Plus petit que (<) », puis renseigner un seuil en Mo. La comparaison est stricte : un fichier d'exactement 10 Mo **n'est pas pris** par `> 10` ni par `< 10`. Les Mo correspondent ici à 1 048 576 octets (MiB).
- **Expression régulière** : une regex JavaScript appliquée au **nom de fichier uniquement**, pas aux dossiers ni au chemin complet. Exemple : `^IMG_[0-9]+\\.(jpg|heic)$` pour cibler `IMG_123.jpg` et `IMG_123.heic`. L'option « Ignorer les majuscules/minuscules » active le drapeau `i`. Laisser le champ vide pour n'imposer aucune condition.
- **Combinaison** : un fichier doit satisfaire **simultanément** le filtre d'extensions (si actif), la condition de taille (si active) et la regex (si renseignée). Les fichiers exclus comptent dans le nombre « exclus » ; ils ne sont ni comparés à la destination, ni copiés, et la simulation applique les mêmes critères.

Par sécurité, le serveur limite les regex à 200 caractères et refuse certains motifs susceptibles de provoquer une évaluation exponentielle (groupes répétés, lookarounds, références arrière, quantificateurs imbriqués). Le filtre de taille est borné à 100 000 000 Mo ; il peut être égal à zéro. **Les règles existantes, dépourvues de ces champs, synchronisent toujours toutes les tailles et tous les noms.**


### Durée écoulée, débit et estimation du temps restant

Pendant une **copie ou un déplacement réel**, le tableau de bord affiche :

- **Volume copié / volume estimé à transférer** et une barre de progression en octets. Le volume prévisionnel est initialisé à partir des tailles des fichiers retenus par les filtres, puis **réduit au fur et à mesure** des doublons déjà présents, des fichiers ignorés et des erreurs. Ce n'est pas un pré-calcul exhaustif des conflits.
- **Durée de transfert écoulée**, mesurée depuis la fin du scan initial (les pauses sont incluses).
- **Débit effectif** calculé à partir des blocs qui traversent le flux de copie ; il est lissé pour éviter de changer brutalement et reste indisponible tant qu'aucun intervalle de mesure suffisant n'a été observé.
- **Temps restant estimé** = octets encore prévus / débit observé. L'estimation se met à jour pendant les copies de gros fichiers, avec un rafraîchissement régulier de l'interface (1,5 s), et s'ajuste si la liste des transferts se réduit.

L'ETA **n'est pas une promesse de durée** : les calculs SHA-256, l'écriture finale sur certains systèmes USB (copie de repli sur exFAT/FAT), les suppressions après déplacement, les variations de débit et les fichiers ignorés ultérieurement peuvent influencer la durée. Le débit affiché correspond aux données traversant le flux de copie, pas au débit théorique de l'interface réseau. L'affichage marque le débit comme indisponible pendant les pauses ou si les derniers octets datent de plus de 12 secondes. La simulation et l'analyse de doublons ne présentent pas d'ETA de **copie** puisqu'aucune donnée n'est transférée.

Les champs API facultatifs `bytesToTransfer`, `bytesTransferred`, `currentFileBytes`, `currentFileSize`, `transferStartedAt`, `transferSpeedBytesPerSec`, `transferEtaSeconds` et `lastTransferAtMs` complètent le suivi existant, sans modifier la compatibilité des tâches et historiques précédents.

### Pause, reprise et annulation

Pour une tâche active, les commandes **Pause** et **Reprendre** pilotent respectivement `POST /api/jobs/:id/pause` et `POST /api/jobs/:id/resume`. La pause fonctionne pendant l'analyse des dossiers et pendant la copie d'un gros fichier (à la prochaine frontière de bloc de données) ; elle ne clôt pas le fichier temporaire. L'annulation reste possible depuis l'état « En pause ». Une pause est **temporaire, en mémoire** : elle ne survit pas au redémarrage du conteneur. Une copie interrompue par une annulation est nettoyée sans publier de fichier incomplet.

### Règles de synchronisation

Si le chemin relatif n'existe pas dans la destination, Network Sync copie le fichier. S'il existe, on compare par défaut les tailles :

- **Même taille** : fichier considéré comme déjà présent, sans nouvelle copie. Activer SHA-256 pour vérifier aussi le contenu.
- **Taille différente** (ou SHA-256 différent) : par défaut créer une copie suffixée, sans écraser le fichier existant.
- **Ignorer** : ne rien copier si le fichier cible existe et diffère.
- **Écraser** : remplacer le fichier cible en cas de différence.

Les transferts s'effectuent d'abord dans un fichier temporaire dans le dossier cible. Les horodatages de modification sont conservés. Les nouvelles versions d'un fichier modifié peuvent être conservées avec un nouveau suffixe. La seule suppression automatique en mode déplacement concerne les fichiers sources transférés et vérifiés (et leurs sous-dossiers devenus vides).

Une seule tâche peut s'exécuter à la fois. Une occurrence cron est ignorée si une autre synchronisation est déjà en cours ; elle n'est pas mise en file d'attente.

### Sécurité

**Ne pas exposer directement le port HTTP sur Internet.** L'authentification Basic doit être protégée par HTTPS si l'application est accessible au-delà d'un réseau local de confiance. Le conteneur ne peut parcourir que les montages que vous lui donnez : dans le Compose générique ces montages sont en lecture/écriture pour laisser les règles entièrement configurables dans l'IHM. Il refuse les liens symboliques en destination et fonctionne sans privilèges Linux supplémentaires. Les destinations et `data` doivent être inscriptibles par le PUID/PGID configuré.

**Sécurité :** le montage en écriture de tout `/volume1` donne à l'application des permissions étendues. Pour limiter la portée, remplacez les montages par les seuls dossiers NAS dont la synchronisation a besoin ; mettez alors leurs chemins dans `SYNC_MOUNT_ROOTS`.

## Développement

Node.js 22+, Angular 20, Express 4 :

    npm install
    npm test
    npm run build
    APP_USERNAME=admin APP_PASSWORD=motdepassefort123 npm start

Les paramètres API `operation` (`copy`, `move` ou `duplicates`) et `layout` (`tree` ou `flat`) sont facultatifs, avec `copy` et `tree` comme valeurs par défaut. `duplicates` utilise un seul dossier source, pas de destination et aucune planification. `sizeFilter` (ex. `{"operator":"gt","megabytes":10}`), `filenameRegex` (ex. `"^IMG_[0-9]+\\.jpg$"`) et `filenameRegexIgnoreCase` et `excludeLivePhotos` (booléen, par défaut `false`) restent facultatifs. Envoyer `null` pour désactiver un filtre. Les règles plus anciennes sont compatibles.

L'API comprend `/api/folders` (création sécurisée de dossiers dans le navigateur), `/api/jobs` (CRUD), `/api/jobs/:id/run` (avec `{"dryRun":true}` optionnel), `/api/jobs/:id/pause`, `/api/jobs/:id/resume`, `/api/jobs/:id/cancel`, `/api/jobs/:id/runs`, `/api/jobs/:id/duplicates`, `/api/jobs/:id/duplicates/delete`, `/api/status`, `/api/settings`, `/api/browse` et `/api/health`. Toutes les routes hormis `/api/health` nécessitent une authentification.

La configuration est stockée dans `data/jobs.json` ; l'historique se trouve dans `data/history/`.
