import { ethers } from 'hardhat'
import { expect } from 'chai'
import { ICapsuleFactory, IERC20, DollarStoreKids } from '../typechain-types'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
const BigNumber = ethers.BigNumber
const { hexlify, solidityKeccak256, zeroPad, hexStripZeros } = ethers.utils
import { impersonateAccount, setBalance } from '@nomicfoundation/hardhat-network-helpers'

describe('Dollar Store Kids tests', async function () {
  const capsuleFactoryAddress = '0x4Ced59c19F1f3a9EeBD670f746B737ACf504d1eB'
  const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const baseURI = 'http://localhost/'
  let dollarStoreKids: DollarStoreKids, capsuleFactory: ICapsuleFactory, capsuleMinter
  let capsule, usdc: IERC20
  let governor: SignerWithAddress, user1: SignerWithAddress, user2: SignerWithAddress

  let capsuleCollectionTax, mintTax, maxUsdcAmount

  async function getUSDC(dollarStore: string, usdcAmount: string | number) {
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    const balanceSlot = 9
    const index = hexStripZeros(hexlify(solidityKeccak256(['uint256', 'uint256'], [dollarStore, balanceSlot])))
    const value = hexlify(zeroPad(BigNumber.from(usdcAmount).toHexString(), 32))
    await ethers.provider.send('hardhat_setStorageAt', [USDC, index, value])
    await ethers.provider.send('evm_mine', [])
  }

  before(async function () {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;[governor, user1, user2] = await ethers.getSigners()
  })

  beforeEach(async function () {
    capsuleFactory = (await ethers.getContractAt('ICapsuleFactory', capsuleFactoryAddress)) as ICapsuleFactory
    capsuleCollectionTax = await capsuleFactory.capsuleCollectionTax()
    // Note setting owner address here so that later we don't have to call connect for owner
    const factory = await ethers.getContractFactory('DollarStoreKids', governor)
    dollarStoreKids = (await factory.deploy(baseURI, { value: capsuleCollectionTax })) as DollarStoreKids

    const collection = await dollarStoreKids.capsuleCollection()
    expect(collection).to.properAddress
    capsule = await ethers.getContractAt('ICapsule', collection)

    capsuleMinter = await ethers.getContractAt('ICapsuleMinter', await dollarStoreKids.CAPSULE_MINTER())
    mintTax = await capsuleMinter.capsuleMintTax()
    maxUsdcAmount = ethers.utils.parseUnits((await dollarStoreKids.MAX_DSK()).toString(), 6)
    usdc = (await ethers.getContractAt('IERC20', usdcAddress)) as IERC20
  })

  context('Verify deployment', function () {
    it('Should verify DSK deployed correctly', async function () {
      // Given DSK is deployed and collection is created
      const maxDSK = await dollarStoreKids.MAX_DSK()
      const maxId = await capsule.maxId()
      // Then maxId should be 1 less than maxDSK. MaxId starts from 0
      expect(maxId, 'collection is not locked properly').to.eq(maxDSK - 1)
      expect(await dollarStoreKids.isMintEnabled(), 'Minting should be disabled').to.false
      const allowance = await usdc.allowance(dollarStoreKids.address, capsuleMinter.address)
      expect(allowance, 'incorrect allowance').to.eq(maxUsdcAmount)
    })
  })

  describe('Mint status', function () {
    it('Should revert if non governor toggle mint status', async function () {
      // When mint status is toggled by non governor user
      const tx = dollarStoreKids.connect(user2).toggleMint()
      // Then revert with
      await expect(tx).to.revertedWith('not governor')
    })

    it('Should toggle mint status', async function () {
      // Given DSK is deployed
      expect(await dollarStoreKids.isMintEnabled(), 'mint should be disabled').to.false
      // When mint status is toggled
      const tx = dollarStoreKids.toggleMint()
      await expect(tx).to.emit(dollarStoreKids, 'MintToggled').withArgs(true)
      // Then minting should be enabled
      expect(await dollarStoreKids.isMintEnabled(), 'mint should be enabled').to.true
      // When mint status is toggled again
      await dollarStoreKids.toggleMint()
      // Then minting should be disabled
      expect(await dollarStoreKids.isMintEnabled(), 'mint should be disabled').to.false
    })
  })

  context('Mint DSK', function () {
    beforeEach(async function () {
      await dollarStoreKids.toggleMint()
    })

    it('Should revert if minting is not allowed', async function () {
      // Given minting is disabled
      await dollarStoreKids.toggleMint()
      // Then mint should revert with mint-is-not-enabled
      await expect(dollarStoreKids.mint()).to.revertedWith('mint-is-not-enabled')
    })

    it('Should revert when mint tax is not sent', async function () {
      // When minting DSK without sending mint tax
      const tx = dollarStoreKids.connect(user1).mint()
      // Then revert with INCORRECT_TAX_AMOUNT = 19
      await expect(tx).to.revertedWith('19')
    })

    it('Should revert when there are no USDC in contract', async function () {
      // When minting DSK
      const tx = dollarStoreKids.connect(user1).mint({ value: mintTax })
      // Then revert with ERC20: transfer amount exceeds balance
      await expect(tx).to.revertedWith('ERC20: transfer amount exceeds balance')
    })

    it('Should mint DSK', async function () {
      // Given DSK has USDC balance
      await getUSDC(dollarStoreKids.address, maxUsdcAmount)
      // Verify USDC balance
      expect(await usdc.balanceOf(dollarStoreKids.address), 'incorrect usdc balance').to.eq(maxUsdcAmount)
      // When minting DSK
      const tx = dollarStoreKids.connect(user1).mint({ value: mintTax })
      // Then verify event is emitted with proper args
      await expect(tx).to.emit(dollarStoreKids, 'DollarStoreKidsMinted').withArgs(user1.address, 0)
    })

    it('Should verify capsule data after DSK minting', async function () {
      // Given DSK has USDC balance
      await getUSDC(dollarStoreKids.address, maxUsdcAmount)
      const id = (await capsule.counter()).toString()
      // When minting dollar
      await dollarStoreKids.connect(user1).mint({ value: mintTax })
      const uri = `${baseURI}${id}`
      // Then verify tokenURI is correct
      expect(await capsule.tokenURI(id), 'tokenURI is incorrect').to.eq(uri)
      const data = await capsuleMinter.singleERC20Capsule(capsule.address, id)
      // Then verify Minter has correct data for ERC20 Capsule
      expect(data._token, 'token should be USDC').to.eq(usdcAddress)
      expect(data._amount, 'amount in Capsule should be 1 USDC').to.eq('1000000')
    })

    it('Should revert when same address minting again', async function () {
      // Given DSK has USDC balance
      await getUSDC(dollarStoreKids.address, maxUsdcAmount)
      // When minting DSK twice
      await dollarStoreKids.connect(user1).mint({ value: mintTax })
      const tx = dollarStoreKids.connect(user1).mint({ value: mintTax })
      // Then 2nd minting should revert with already-minted-dollar
      await expect(tx, 'should fail with correct message').to.revertedWith('already-minted-dsk')
    })
  })

  context('Burn DSK', function () {
    let id
    beforeEach(async function () {
      await dollarStoreKids.toggleMint()
      await getUSDC(dollarStoreKids.address, maxUsdcAmount)
      id = await capsule.counter()
      await dollarStoreKids.connect(user2).mint({ value: mintTax })
    })

    it('should burn DSK', async function () {
      // Given user2 already minted DSK and approved DSK for burning
      await capsule.connect(user2).approve(dollarStoreKids.address, id)
      // Then verify user2 DSK balance is 1
      expect(await capsule.balanceOf(user2.address), 'incorrect balance').to.eq(1)
      // Then verify user2 is owner of DSK
      expect(await capsule.ownerOf(id), '!owner').to.eq(user2.address)
      // When user2 burns DSK
      const tx = dollarStoreKids.connect(user2).burn(id)
      // Then verify event is emitted with proper args
      await expect(tx).to.emit(dollarStoreKids, 'DollarStoreKidsBurnt').withArgs(user2.address, id)
      // Then verify user2 DSK balance is zero
      expect(await capsule.balanceOf(user2.address), 'incorrect balance').to.eq(0)
    })

    it('should verify USDC balance after burning DSK ', async function () {
      // Given user2 has a DSK
      const usdcBefore = await usdc.balanceOf(user2.address)
      await capsule.connect(user2).approve(dollarStoreKids.address, id)
      // When user2 is burns DSK
      await dollarStoreKids.connect(user2).burn(id)
      const usdcAfter = await usdc.balanceOf(user2.address)
      // Then USDC balance of user2 should increase by 1 USDC
      expect(usdcAfter, 'balance should be 1 USDC more than before').to.eq(usdcBefore.add('1000000'))
    })
  })

  context('Transfer collection ownership', function () {
    it('Should revert if non governor user call transfer ownership', async function () {
      const tx = dollarStoreKids.connect(user1).transferCollectionOwnership(user2.address)
      await expect(tx).to.revertedWith('not governor')
    })

    it('Should transfer collection ownership of DSK collection', async function () {
      expect(await capsule.owner()).to.eq(dollarStoreKids.address)
      await dollarStoreKids.transferCollectionOwnership(user1.address)
      expect(await capsule.owner()).to.eq(user1.address)
    })
  })

  context('Update MetaMaster', function () {
    it('Should revert if non governor user call update meta master', async function () {
      const tx = dollarStoreKids.connect(user1).updateMetamaster(user2.address)
      await expect(tx).to.revertedWith('not governor')
    })

    it('Should update meta master of DSK collection', async function () {
      expect(await capsule.tokenURIOwner()).to.eq(dollarStoreKids.address)
      await dollarStoreKids.updateMetamaster(user1.address)
      expect(await capsule.tokenURIOwner()).to.eq(user1.address)
    })
  })

  context('Update baseURI', function () {
    it('Should revert if non governor user call updateBaseURI', async function () {
      const tx = dollarStoreKids.connect(user1).updateBaseURI('https://google.com')
      await expect(tx).revertedWith('not governor')
    })

    it('Should update baseURI of DSK collection', async function () {
      const newBaseURI = 'https://www.google.com'
      expect(await capsule.baseURI()).eq(baseURI)
      await dollarStoreKids.updateBaseURI(newBaseURI)
      expect(await capsule.baseURI()).eq(newBaseURI)
    })
  })

  context('Royalty', function () {
    const ZERO_ADDRESS = ethers.constants.AddressZero
    it('Should allow governor to update royalty config', async function () {
      // Given royalty receiver and rate are not set
      expect(await capsule.royaltyReceiver(), 'receiver should be zero').eq(ZERO_ADDRESS)
      expect(await capsule.royaltyRate(), 'royalty rate should be zero').eq(0)
      //When updating config. User2 as receiver and 2% rate
      const tx = await dollarStoreKids.connect(governor).updateRoyaltyConfig(user2.address, 200)
      // Then verify receiver and rate are updated correctly and event is emitted
      expect(tx).emit(capsule, 'RoyaltyConfigUpdated').withArgs(ZERO_ADDRESS, user2.address, 0, 200)
      expect(await capsule.royaltyReceiver(), 'incorrect receiver').eq(user2.address)
      expect(await capsule.royaltyRate(), 'royalty rate should be 200').eq(200)
    })

    it('Should revert if non governor calls update', async function () {
      // When updating rate to > 100%
      const tx = dollarStoreKids.connect(user1).updateRoyaltyConfig(user2.address, 10001)
      // Then revert
      await expect(tx).revertedWith('not governor')
    })

    it('Should be able to get royalty info', async function () {
      // Given royalty config is not set.
      const royaltyInfo = await capsule.royaltyInfo(0, 0)
      // Then expect a response for token id 0 to be (zero address and 0 amount)
      expect(royaltyInfo.receiver, 'incorrect royalty receiver').to.eq(ZERO_ADDRESS)
      expect(royaltyInfo.royaltyAmount, 'incorrect output royalty amount').to.eq(0)

      // When updating the royaltyReceiver to user 2 and royaltyRate to 1%
      await dollarStoreKids.connect(governor).updateRoyaltyConfig(user2.address, 100)
      // When getting royalty info for tokenId 0 and sale price 500
      const royaltyInfo2 = await capsule.royaltyInfo(0, 500)
      // Then expect a response for token id 0 to be (user2, 1)
      expect(royaltyInfo2.receiver, 'incorrect royalty receiver').to.eq(user2.address)
      expect(royaltyInfo2.royaltyAmount, 'incorrect output royalty amount').to.eq(5)
    })
  })

  context('Sweep tokens', function () {
    it('Should sweep DAI from DSK', async function () {
      const daiAddress = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
      const daiWhale = '0x6c6bc977e13df9b0de53b251522280bb72383700'
      // Add 10 ETH to whale account
      await setBalance(daiWhale, ethers.utils.parseEther('10'))

      // Impersonate DAI whale account
      await impersonateAccount(daiWhale)
      const whaleSigner = await ethers.getSigner(daiWhale)
      const dai = (await ethers.getContractAt('IERC20', daiAddress)) as IERC20

      // Given someone send DAI to DSK contract
      const daiAmount = ethers.utils.parseEther('1500')
      await dai.connect(whaleSigner).transfer(dollarStoreKids.address, daiAmount)

      // Verify DSK has DAI
      const daiBalance = await dai.balanceOf(dollarStoreKids.address)
      expect(daiBalance, 'incorrect DAI balance').to.eq(daiAmount)
      // Verify governor has no DAI
      const daiBalanceOwner = await dai.balanceOf(governor.address)
      expect(daiBalanceOwner, 'DAI balance should be zero').to.eq(0)

      // When governor sweep DAI
      await dollarStoreKids.sweep(daiAddress)

      // Then verify DSK has no DAI
      const daiBalance2 = await dai.balanceOf(dollarStoreKids.address)
      expect(daiBalance2, 'DAI balance should be zero').to.eq(0)
      // Then verify governor has new DAI balance
      const daiBalanceOwner2 = await dai.balanceOf(governor.address)
      expect(daiBalanceOwner2, 'incorrect DAI balance').to.eq(daiAmount)
    })
  })
})
