package records

type DownloadStage struct {
	Phase       string
	ID          string
	Producer    Helper
	Device      string
	Inode       string
	BirthtimeNS string
}

type DownloadIntent struct {
	BuildID       string
	ArchiveSHA256 string
	Download      *DownloadStage
}

func DecodeDownload(data []byte) (*DownloadIntent, error) {
	m, err := decode(data)
	if err != nil {
		return nil, err
	}
	m, ok := object(m, []string{"schema", "buildId", "archiveSha256"}, []string{"download"})
	if !ok || m["schema"] != "farol.update-download-intent/1" {
		return nil, Invalid
	}
	id, a := hex(m["buildId"], 64)
	sha, b := hex(m["archiveSha256"], 64)
	if !a || !b {
		return nil, Invalid
	}
	r := &DownloadIntent{BuildID: id, ArchiveSHA256: sha}
	v, present := m["download"]
	if !present {
		return r, nil
	}
	d, ok := object(v, []string{"id", "producer"}, []string{"phase", "identity"})
	if !ok {
		return nil, Invalid
	}
	stageID, a := hex(d["id"], 32)
	producer, b := helper(d["producer"], false)
	if !a || !b {
		return nil, Invalid
	}
	stage := &DownloadStage{ID: stageID, Producer: *producer}
	if value, exists := d["phase"]; exists {
		p, ok := value.(string)
		if !ok || (p != "downloading" && p != "verifying") {
			return nil, Invalid
		}
		stage.Phase = p
	}
	if value, exists := d["identity"]; exists {
		i, ok := object(value, []string{"dev", "ino", "birthtimeNs"}, nil)
		if !ok {
			return nil, Invalid
		}
		dev, a := decimal(i["dev"])
		ino, b := decimal(i["ino"])
		birth, c := decimal(i["birthtimeNs"])
		if !a || !b || !c {
			return nil, Invalid
		}
		stage.Device, stage.Inode, stage.BirthtimeNS = dev, ino, birth
	}
	r.Download = stage
	return r, nil
}
